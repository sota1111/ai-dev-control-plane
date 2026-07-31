import {
  parseKaggleSubmissionsCsv,
  formatPreviousSubmission,
  filterFailureLog,
  buildRecentIssuesDigest,
  hasScoredSubmissionSince,
  submissionRowsForRepo,
  classifyKaggleCliFailure,
  type CompletedIssue,
} from '../lib/kaggleImproveMaterial.js';

// SOT-1913 材料自動収集の純関数ヘルパー。cron が起案本文へ埋め込む「入力材料」を空にしないための収集ロジック。
describe('kaggleImproveMaterial', () => {
  describe('parseKaggleSubmissionsCsv', () => {
    test('parses header + rows, resolving columns by name', () => {
      const csv = [
        'fileName,date,description,status,publicScore,privateScore',
        'submission.csv,2026-07-29 03:00:00,"auto-improve, champion",complete,0.512,',
        'old.csv,2026-07-28 03:00:00,prev,complete,0.500,0.499',
      ].join('\n');
      const rows = parseKaggleSubmissionsCsv(csv);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        fileName: 'submission.csv',
        date: '2026-07-29 03:00:00',
        description: 'auto-improve, champion', // comma inside quotes preserved
        status: 'complete',
        publicScore: '0.512',
      });
      expect(rows[0].privateScore).toBeUndefined(); // empty cell → undefined
      expect(rows[1].privateScore).toBe('0.499');
    });

    test('tolerates warning noise before the header and returns [] when no header', () => {
      const withNoise = ['Warning: something', 'fileName,date,status,publicScore', 'a.csv,2026-07-29,complete,0.3'].join('\n');
      expect(parseKaggleSubmissionsCsv(withNoise)).toHaveLength(1);
      expect(parseKaggleSubmissionsCsv('')).toEqual([]);
      expect(parseKaggleSubmissionsCsv('nothing useful here')).toEqual([]);
    });
  });

  describe('formatPreviousSubmission', () => {
    test('formats up to maxRows most-recent-first rows', () => {
      const out = formatPreviousSubmission([
        { date: '2026-07-29', status: 'complete', publicScore: '0.51', fileName: 'a.csv' },
        { date: '2026-07-28', status: 'error', fileName: 'b.csv' },
      ]);
      expect(out).toContain('2026-07-29');
      expect(out).toContain('status=complete');
      expect(out).toContain('public=0.51');
      expect(out).toContain('file=a.csv');
      expect(out).toContain('status=error');
    });

    test('returns undefined when there are no rows', () => {
      expect(formatPreviousSubmission([])).toBeUndefined();
    });
  });

  describe('hasScoredSubmissionSince', () => {
    const rows = [
      {
        date: '2026-07-31 09:00:15.480000',
        status: 'SubmissionStatus.COMPLETE',
        publicScore: '0.000',
      },
      {
        date: '2026-07-31 09:00:12.493000',
        status: 'SubmissionStatus.PENDING',
      },
    ];

    test('treats a newly completed score, including zero, as new material', () => {
      expect(hasScoredSubmissionSince(rows, '2026-07-31T08:00:00Z')).toBe(true);
    });

    test('does not retrigger for an already-consumed score or a pending submission', () => {
      expect(hasScoredSubmissionSince(rows, '2026-07-31T10:00:00Z')).toBe(false);
      expect(
        hasScoredSubmissionSince(
          [{ date: '2026-07-31 11:00:00', status: 'PENDING', publicScore: '1.0' }],
          '2026-07-31T10:00:00Z'
        )
      ).toBe(false);
    });
  });

  describe('submissionRowsForRepo', () => {
    const rows = [
      {
        description: 'auto-improve biohub-claude [repo:biohub-claude]',
        status: 'COMPLETE',
        publicScore: '0.509',
      },
      {
        description: 'auto-improve biohub-gpt [repo:biohub-gpt]',
        status: 'PENDING',
      },
      { description: 'manual submission', status: 'COMPLETE', publicScore: '0.7' },
    ];

    test('attributes completed scores only to their own lineage', () => {
      const claude = submissionRowsForRepo(rows, 'biohub-claude');
      const gpt = submissionRowsForRepo(rows, 'biohub-gpt');
      expect(claude).toHaveLength(1);
      expect(gpt).toHaveLength(1);
      expect(hasScoredSubmissionSince(claude, null)).toBe(true);
      expect(hasScoredSubmissionSince(gpt, null)).toBe(false);
    });

    test('does not assign an unidentifiable submission to either lineage', () => {
      expect(submissionRowsForRepo([rows[2]], 'biohub-claude')).toEqual([]);
      expect(submissionRowsForRepo([rows[2]], 'biohub-gpt')).toEqual([]);
    });
  });

  describe('classifyKaggleCliFailure', () => {
    test('distinguishes missing CLI, authentication failures, and transient API failures', () => {
      expect(classifyKaggleCliFailure({ code: 'ENOENT', message: 'spawnSync kaggle ENOENT' }))
        .toContain('not installed');
      expect(classifyKaggleCliFailure({ stderr: '401 Unauthorized: check kaggle.json' }))
        .toContain('authentication failed');
      expect(classifyKaggleCliFailure({ stderr: '503 Service Unavailable' }))
        .toContain('submissions API failed');
    });

    test('does not echo raw stderr that could contain credential details', () => {
      const reason = classifyKaggleCliFailure({
        stderr: '403 credential secret-value-was-here',
      });
      expect(reason).not.toContain('secret-value-was-here');
    });
  });

  describe('filterFailureLog', () => {
    const log = [
      '# failure-log',
      '- 2026-07-29 agent-security-claude score0乖離 …',
      '- 2026-07-28 ptcg-agent-claude deckout …',
      '- 2026-07-27 arc-agi-2 gate修正 …',
    ].join('\n');

    test('keeps only lines matching a key (case-insensitive)', () => {
      const out = filterFailureLog(log, ['agent-security-claude', 'agent-security']);
      expect(out).toContain('agent-security-claude');
      expect(out).not.toContain('ptcg-agent-claude');
      expect(out).not.toContain('arc-agi-2');
    });

    test('returns undefined when nothing matches or keys empty', () => {
      expect(filterFailureLog(log, ['no-such-repo'])).toBeUndefined();
      expect(filterFailureLog(log, [''])).toBeUndefined();
      expect(filterFailureLog('', ['agent-security'])).toBeUndefined();
    });

    test('truncates at maxLines with an omission marker', () => {
      const many = Array.from({ length: 5 }, (_, i) => `- key line ${i}`).join('\n');
      const out = filterFailureLog(many, ['key'], 2);
      expect(out).toContain('省略');
    });
  });

  describe('buildRecentIssuesDigest', () => {
    const issues: CompletedIssue[] = [
      { identifier: 'SOT-300', title: 'child A', completedAt: '2026-07-29T10:00:00Z', stateName: 'Done' },
      { identifier: 'SOT-290', title: 'child B', completedAt: '2026-07-20T10:00:00Z', stateName: 'Done' },
      { identifier: 'SOT-280', title: 'old parent', completedAt: '2026-07-10T10:00:00Z', isAutoImprove: true },
    ];

    test('with a since-cutoff, only newer non-auto-improve issues count as new material', () => {
      const r = buildRecentIssuesDigest(issues, '2026-07-25T00:00:00Z');
      expect(r.hasNewMaterial).toBe(true);
      expect(r.digest).toContain('SOT-300');
      expect(r.digest).not.toContain('SOT-290'); // before cutoff
      expect(r.digest).not.toContain('SOT-280'); // auto-improve parent excluded
    });

    test('no new completed issue since cutoff → hasNewMaterial false, no digest', () => {
      const r = buildRecentIssuesDigest(issues, '2026-07-29T23:00:00Z');
      expect(r.hasNewMaterial).toBe(false);
      expect(r.digest).toBeUndefined();
    });

    test('null cutoff (bootstrap) → hasNewMaterial true and digest of all non-auto issues', () => {
      const r = buildRecentIssuesDigest(issues, null);
      expect(r.hasNewMaterial).toBe(true);
      expect(r.digest).toContain('SOT-300');
      expect(r.digest).toContain('SOT-290');
      expect(r.digest).not.toContain('SOT-280');
    });

    test('sorts most-recent first and caps at maxItems', () => {
      const many: CompletedIssue[] = Array.from({ length: 10 }, (_, i) => ({
        identifier: `SOT-${i}`,
        title: `t${i}`,
        completedAt: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      }));
      const r = buildRecentIssuesDigest(many, null, 3);
      const lines = (r.digest || '').split('\n');
      expect(lines[0]).toContain('SOT-9'); // newest first
      expect(r.digest).toContain('他 7 件');
    });
  });
});
