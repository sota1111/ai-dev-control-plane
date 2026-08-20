import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseKaggleSubmissionsCsv,
  formatPreviousSubmission,
  filterFailureLog,
  buildRecentIssuesDigest,
  hasScoredSubmissionSince,
  hasSubmissionSince,
  submissionRowsForRepo,
  classifyKaggleCliFailure,
  parseCvReport,
  readCvReport,
  formatCvSummary,
  computeCvPublicGap,
  formatCvPublicGapSummary,
  referenceOverfitWarning,
  formatCvGapTrend,
  parseCvGapHistory,
  parseCvScoreHistory,
  computeOracleDriftSignal,
  DEFAULT_PROXY_SATURATION_MIN_IMPROVEMENT,
  DEFAULT_TRUE_KPI_MIN_IMPROVEMENT,
  detectSubmissionHealth,
  submissionRowState,
  computeRankTrend,
  SUBMISSION_BROKEN_CONSECUTIVE,
  CV_PUBLIC_GAP_RELATIVE_WARN,
  REFERENCE_OVERFIT_RELATIVE_MARGIN,
  type CompletedIssue,
} from '../lib/kaggleImproveMaterial.js';
import {
  detectOracleDrift,
  buildOracleDriftBanner,
  DEFAULT_ORACLE_DRIFT_REANCHOR_CYCLES,
  DEFAULT_ORACLE_DRIFT_ESCALATE_CYCLES,
} from '../lib/kaggleImprovement.js';

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

  describe('hasSubmissionSince', () => {
    test('treats a new PENDING submission as material for the next scheduled cycle', () => {
      expect(
        hasSubmissionSince(
          [{ date: '2026-07-31 11:00:00', status: 'SubmissionStatus.PENDING' }],
          '2026-07-31T10:00:00Z'
        )
      ).toBe(true);
    });

    test('does not consume the same PENDING submission more than once', () => {
      expect(
        hasSubmissionSince(
          [{ date: '2026-07-31 09:00:00', status: 'SubmissionStatus.PENDING' }],
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

    test('attributes submissions only to their own lineage, including pending material', () => {
      const claude = submissionRowsForRepo(rows, 'biohub-claude');
      const gpt = submissionRowsForRepo(rows, 'biohub-gpt');
      expect(claude).toHaveLength(1);
      expect(gpt).toHaveLength(1);
      expect(hasScoredSubmissionSince(claude, null)).toBe(true);
      expect(hasScoredSubmissionSince(gpt, null)).toBe(false);
      expect(hasSubmissionSince(claude, null)).toBe(true);
      expect(hasSubmissionSince(gpt, null)).toBe(true);
    });

    test('does not assign an unidentifiable submission to either lineage', () => {
      expect(submissionRowsForRepo([rows[2]], 'biohub-claude')).toEqual([]);
      expect(submissionRowsForRepo([rows[2]], 'biohub-gpt')).toEqual([]);
    });

    test('single-target competition credits unmarked submissions to its only repo', () => {
      // A single-target competition (e.g. rogii, claude-only) means every
      // submission to that Kaggle competition belongs to the one repo, even
      // direct `kaggle competitions submit` runs whose message lacks a marker.
      const singleTargetRows = [
        { description: 'cycle-3 champion [repo:rogii-claude]', status: 'COMPLETE', publicScore: '8.739' },
        { description: 'medal push: full reference pipeline port', status: 'COMPLETE', publicScore: '6.477' },
        { description: 'auto-improve submit: rogii-gpt champion [repo:rogii-gpt]', status: 'COMPLETE', publicScore: '11551.955' },
      ];
      const credited = submissionRowsForRepo(singleTargetRows, 'rogii-claude', { singleTarget: true });
      // includes the marked own-repo row and the unmarked direct submission,
      // excludes the row explicitly marked for the other (historical) repo.
      expect(credited.map((r) => r.publicScore)).toEqual(['8.739', '6.477']);
      // Without the single-target flag the unmarked 6.477 is dropped (multi-target behaviour).
      expect(submissionRowsForRepo(singleTargetRows, 'rogii-claude').map((r) => r.publicScore)).toEqual(['8.739']);
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

  // SOT-2514: leak-free CV レポート → cvSummary / CV↔public gap / 参照実装スコア警告。
  describe('parseCvReport', () => {
    const valid = {
      cv_scheme: 'group-kfold',
      entity_unit: 'well',
      folds: 5,
      score: 8.31,
      per_entity_scores: [7.2, 9.1, 8.3, 11.4, 5.6],
    };

    test('accepts an entity-unit hold-out report and keeps per-entity scores', () => {
      const r = parseCvReport(valid);
      expect(r.violation).toBeUndefined();
      expect(r.report).toMatchObject({
        cvScheme: 'group-kfold',
        entityUnit: 'well',
        folds: 5,
        score: 8.31,
      });
      expect(r.report?.perEntityScores).toEqual([7.2, 9.1, 8.3, 11.4, 5.6]);
    });

    test('camelCase keys are accepted and per_entity_scores is optional', () => {
      const r = parseCvReport({ cvScheme: 'time-split', entityUnit: 'series', folds: 3, score: 0.42 });
      expect(r.report).toMatchObject({ cvScheme: 'time-split', entityUnit: 'series', score: 0.42 });
      expect(r.report?.perEntityScores).toBeUndefined();
    });

    test('a non-object or missing/invalid fields are a CV contract violation, never a throw', () => {
      expect(parseCvReport(null).violation).toContain('CV契約違反');
      expect(parseCvReport([1, 2]).violation).toContain('CV契約違反');
      const missing = parseCvReport({ cv_scheme: 'kfold', folds: 5 });
      expect(missing.report).toBeUndefined();
      expect(missing.violation).toContain('entity_unit');
      expect(missing.violation).toContain('score');
    });

    test('row-level CV (entity_unit=row/record/…) is flagged as a leak contract violation', () => {
      for (const unit of ['row', 'record', 'sample', '行', 'per-row']) {
        const r = parseCvReport({ cv_scheme: 'kfold', entity_unit: unit, folds: 5, score: 1 });
        expect(r.report).toBeUndefined();
        expect(r.violation).toContain('行単位CV');
        expect(r.violation).toContain('P1');
      }
    });

    test('drops per_entity_scores when it contains non-finite values', () => {
      const r = parseCvReport({ ...valid, per_entity_scores: [1, 'x', 3] });
      expect(r.report?.perEntityScores).toBeUndefined();
    });
  });

  describe('readCvReport', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvreport-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('missing file returns an empty result (→ SOT-2513 fail-safe path), no throw', () => {
      const r = readCvReport(path.join(dir, 'nope.json'));
      expect(r.report).toBeUndefined();
      expect(r.violation).toBeUndefined();
    });

    test('malformed JSON is a contract violation, not a crash', () => {
      const f = path.join(dir, 'cv_report.json');
      fs.writeFileSync(f, '{not json');
      expect(readCvReport(f).violation).toContain('CV契約違反');
    });

    test('a valid report file round-trips to a report', () => {
      const f = path.join(dir, 'cv_report.json');
      fs.writeFileSync(f, JSON.stringify({ cv_scheme: 'group', entity_unit: 'well', folds: 4, score: 2.5 }));
      expect(readCvReport(f).report).toMatchObject({ entityUnit: 'well', score: 2.5 });
    });
  });

  describe('formatCvSummary', () => {
    test('renders scheme/entity/folds and a per-entity range when present', () => {
      const s = formatCvSummary({
        cvScheme: 'group-kfold',
        entityUnit: 'well',
        folds: 5,
        score: 8.31,
        perEntityScores: [5.6, 11.4, 8.3],
      });
      expect(s).toContain('CV score 8.31');
      expect(s).toContain('well単位hold-out');
      expect(s).toContain('5-fold');
      expect(s).toContain('per-entity(3)');
      expect(s).toContain('range [5.6, 11.4]');
    });

    test('omits the per-entity line when absent', () => {
      const s = formatCvSummary({ cvScheme: 'time', entityUnit: 'series', folds: 3, score: 0.4 });
      expect(s).not.toContain('per-entity');
    });
  });

  describe('computeCvPublicGap / formatCvPublicGapSummary', () => {
    test('relative gap is normalized by |public| and drives the ⚠ threshold', () => {
      // CV 8.3 vs public 6.4 → ~30% relative gap, over the 10% warn threshold.
      const gap = computeCvPublicGap(8.3, 6.4);
      expect(gap.absolute).toBeCloseTo(1.9, 6);
      expect(gap.relative).toBeGreaterThan(CV_PUBLIC_GAP_RELATIVE_WARN);
      const summary = formatCvPublicGapSummary(gap);
      expect(summary).toContain('CV最良 8.3');
      expect(summary).toContain('public最良 6.4');
      expect(summary).toContain('悲観側(CV)を信じ');
    });

    test('a small divergence stays below the warn threshold', () => {
      const gap = computeCvPublicGap(6.45, 6.4);
      expect(gap.relative).toBeLessThan(CV_PUBLIC_GAP_RELATIVE_WARN);
    });
  });

  describe('referenceOverfitWarning (playbook P5)', () => {
    test('min-direction: beating the reference by more than the margin warns', () => {
      // rogii: reference 7.872, our port 6.477 (lower is better) → beat by ~18%.
      const w = referenceOverfitWarning(6.477, 7.872, 'min');
      expect(w).toContain('過学習疑い');
      expect(w).toContain('P5');
      expect(w).toContain('6.477');
      expect(w).toContain('7.872');
    });

    test('max-direction: beating the reference upward warns; matching it does not', () => {
      expect(referenceOverfitWarning(0.95, 0.9, 'max')).toContain('過学習疑い');
      expect(referenceOverfitWarning(0.9, 0.9, 'max')).toBeUndefined();
    });

    test('being at or worse than the reference does not warn', () => {
      expect(referenceOverfitWarning(7.9, 7.872, 'min')).toBeUndefined(); // worse (higher) in min
      expect(referenceOverfitWarning(0.85, 0.9, 'max')).toBeUndefined(); // worse (lower) in max
    });

    test('a within-margin overshoot is not significant', () => {
      const within = 0.9 * (1 + REFERENCE_OVERFIT_RELATIVE_MARGIN / 2);
      expect(referenceOverfitWarning(within, 0.9, 'max')).toBeUndefined();
    });
  });

  describe('formatCvGapTrend / parseCvGapHistory', () => {
    test('a widening gap history flags 汎化リスク増大', () => {
      const out = formatCvGapTrend([0.05, 0.12, 0.3]);
      expect(out).toContain('gap 推移');
      expect(out).toContain('汎化リスク増大');
      expect(out).toContain('拡大傾向');
    });

    test('a stable/narrowing history shows the trend without a warning', () => {
      const out = formatCvGapTrend([0.3, 0.2, 0.1]);
      expect(out).toContain('gap 推移');
      expect(out).not.toContain('汎化リスク増大');
    });

    test('fewer than two points has no trend', () => {
      expect(formatCvGapTrend([])).toBeUndefined();
      expect(formatCvGapTrend([0.2])).toBeUndefined();
    });

    test('parseCvGapHistory reads relativeGap or derives it from score/publicScore, skipping junk', () => {
      const jsonl = [
        '{"relativeGap": 0.05}',
        'not-json',
        '{"score": 8.3, "publicScore": 6.4}',
        '{"unrelated": true}',
      ].join('\n');
      const gaps = parseCvGapHistory(jsonl);
      expect(gaps).toHaveLength(2);
      expect(gaps[0]).toBeCloseTo(0.05, 6);
      expect(gaps[1]).toBeCloseTo(computeCvPublicGap(8.3, 6.4).relative, 6);
    });
  });

  // SOT-2518 P8: 提出アウトカム preflight（submissionHealth = broken 検出）。
  describe('submissionRowState', () => {
    test('classifies pending / error / scored-zero / healthy rows', () => {
      expect(submissionRowState({ status: 'SubmissionStatus.PENDING' })).toBe('pending');
      expect(submissionRowState({ status: '' })).toBe('pending');
      expect(submissionRowState({ status: 'SubmissionStatus.ERROR' })).toBe('unhealthy');
      expect(submissionRowState({ status: 'COMPLETE', publicScore: '0.000' })).toBe('unhealthy');
      expect(submissionRowState({ status: 'COMPLETE' })).toBe('unhealthy'); // missing score
      expect(submissionRowState({ status: 'SubmissionStatus.COMPLETE', publicScore: '0.512' })).toBe('healthy');
    });
  });

  describe('detectSubmissionHealth', () => {
    const broken = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        date: `2026-08-0${i + 1} 09:00:00`,
        status: 'SubmissionStatus.ERROR',
      }));

    test('flags broken when the last N (default 3) non-pending rows are all unhealthy', () => {
      const h = detectSubmissionHealth(broken(3));
      expect(h.status).toBe('broken');
      expect(h.consecutiveBroken).toBe(3);
      expect(h.reason).toContain('提出パイプライン');
    });

    test('a run of scored-zero submissions is also broken', () => {
      const rows = Array.from({ length: 3 }, (_, i) => ({
        date: `2026-08-0${i + 1} 09:00:00`,
        status: 'SubmissionStatus.COMPLETE',
        publicScore: '0.000',
      }));
      expect(detectSubmissionHealth(rows).status).toBe('broken');
    });

    test('pending rows at the top are ignored, not counted as broken', () => {
      const rows = [
        { date: '2026-08-05 09:00:00', status: 'SubmissionStatus.PENDING' },
        ...broken(3),
      ];
      expect(detectSubmissionHealth(rows).status).toBe('broken');
    });

    test('a recent healthy submission makes it ok even if older ones failed', () => {
      const rows = [
        { date: '2026-08-05 09:00:00', status: 'COMPLETE', publicScore: '0.51' },
        ...broken(3),
      ];
      const h = detectSubmissionHealth(rows);
      expect(h.status).toBe('ok');
      expect(h.consecutiveBroken).toBe(0);
    });

    test('fewer consecutive failures than the threshold is unknown, not broken', () => {
      const h = detectSubmissionHealth(broken(2));
      expect(h.status).toBe('unknown');
      expect(h.consecutiveBroken).toBe(2);
    });

    test('no scored/failed rows at all (empty or all pending) is unknown', () => {
      expect(detectSubmissionHealth([]).status).toBe('unknown');
      expect(
        detectSubmissionHealth([{ status: 'SubmissionStatus.PENDING' }]).status
      ).toBe('unknown');
    });

    test('the consecutive threshold is configurable', () => {
      expect(detectSubmissionHealth(broken(2), 2).status).toBe('broken');
      expect(SUBMISSION_BROKEN_CONSECUTIVE).toBe(3);
    });
  });

  // SOT-2518 P9: 実LB順位トレンド（維持=後退検知）。順位は小さいほど良い（rank 1 = 首位）。
  describe('computeRankTrend', () => {
    test('rising rank number over time is a declining trend with a ⚠', () => {
      const t = computeRankTrend([{ rank: 42 }, { rank: 55 }, { rank: 70 }]);
      expect(t.direction).toBe('declining');
      expect(t.summary).toContain('低下傾向');
      expect(t.summary).toContain('42位');
      expect(t.summary).toContain('70位');
    });

    test('falling off the leaderboard (null last) counts as declining', () => {
      const t = computeRankTrend([{ rank: 300, totalListed: 599 }, { rank: null, totalListed: 599 }]);
      expect(t.direction).toBe('declining');
      expect(t.summary).toContain('圏外');
    });

    test('improving and flat trends', () => {
      expect(computeRankTrend([{ rank: 80 }, { rank: 40 }]).direction).toBe('improving');
      expect(computeRankTrend([{ rank: 50 }, { rank: 50 }]).direction).toBe('flat');
    });

    test('a single observation is "new"; empty is "unknown"', () => {
      expect(computeRankTrend([{ rank: 42 }]).direction).toBe('new');
      expect(computeRankTrend([]).direction).toBe('unknown');
    });
  });

  // SOT-2745: oracle-drift シグナルを proxy(CV)/真KPI(順位) history から決定論算出する。
  describe('parseCvScoreHistory', () => {
    test('extracts the CV score series in order, ignoring malformed / score-less lines', () => {
      const content = [
        JSON.stringify({ score: 0.80, publicScore: 0.75 }),
        '{not json',
        JSON.stringify({ relativeGap: 0.1 }), // score なし → 無視
        JSON.stringify({ score: 0.88 }),
        '',
        JSON.stringify({ score: 'x' }), // 非数値 → 無視
      ].join('\n');
      expect(parseCvScoreHistory(content)).toEqual([0.8, 0.88]);
    });

    test('empty content yields an empty series', () => {
      expect(parseCvScoreHistory('')).toEqual([]);
    });
  });

  describe('computeOracleDriftSignal', () => {
    // proxy は大きいほど良い(max)、真KPI=順位は小さいほど良い(min)。
    const proxy = (series: number[]) => ({
      series,
      direction: 'max' as const,
      minImprovement: DEFAULT_PROXY_SATURATION_MIN_IMPROVEMENT,
      name: 'leak-free CV',
    });
    const rank = (series: number[]) => ({
      series,
      direction: 'min' as const,
      minImprovement: DEFAULT_TRUE_KPI_MIN_IMPROVEMENT,
      name: 'public LB 順位',
    });

    test('proxy saturated only (true KPI still improving) does NOT drift', () => {
      // proxy 頭打ち（0.900→0.901≒改善0）だが順位は 40→30 と改善 → drift でない。
      const sig = computeOracleDriftSignal(proxy([0.9, 0.901]), rank([40, 30]));
      expect(sig).toBeDefined();
      expect(sig!.proxySaturated).toBe(true);
      expect(sig!.trueKpiStagnant).toBe(false);
      expect(sig!.stagnantCycles).toBe(0);
      expect(detectOracleDrift(sig).level).toBe('none');
      expect(detectOracleDrift(sig).drifting).toBe(false);
    });

    test('true KPI stagnant only (proxy still improving) does NOT drift', () => {
      // 順位停滞（30→30）だが proxy は 0.80→0.90 と大きく改善 → drift でない。
      const sig = computeOracleDriftSignal(proxy([0.8, 0.9]), rank([30, 30]));
      expect(sig).toBeDefined();
      expect(sig!.proxySaturated).toBe(false);
      expect(sig!.trueKpiStagnant).toBe(true);
      expect(sig!.stagnantCycles).toBe(0);
      expect(detectOracleDrift(sig).level).toBe('none');
    });

    test('both saturated & stagnant for 2 cycles → reanchor (banner fires)', () => {
      // post-mortem 再現: proxy はほぼ頭打ちで微増(<0.005)、真KPI(順位)は据置き（3観測=2ステップ）。
      const sig = computeOracleDriftSignal(proxy([0.98, 0.982, 0.984]), rank([26, 26, 26]));
      expect(sig).toBeDefined();
      expect(sig!.proxySaturated).toBe(true);
      expect(sig!.trueKpiStagnant).toBe(true);
      expect(sig!.stagnantCycles).toBe(DEFAULT_ORACLE_DRIFT_REANCHOR_CYCLES);
      const result = detectOracleDrift(sig);
      expect(result.level).toBe('reanchor');
      expect(result.drifting).toBe(true);
      // wiring が実データ history から供給した signal で実際にバナーが発火することを確認。
      const banner = buildOracleDriftBanner(sig, result);
      expect(banner).toContain('再アンカー');
    });

    test('both saturated & stagnant for 4 cycles → escalate', () => {
      const sig = computeOracleDriftSignal(
        proxy([0.98, 0.982, 0.984, 0.986, 0.988]),
        rank([26, 26, 26, 26, 26])
      );
      expect(sig!.stagnantCycles).toBe(DEFAULT_ORACLE_DRIFT_ESCALATE_CYCLES);
      expect(detectOracleDrift(sig).level).toBe('escalate');
    });

    test('a worsening true KPI (rank rising) while proxy plateaus still drifts', () => {
      // 順位が悪化(26→30)しても改善<閾値なので停滞扱い＝drift。
      const sig = computeOracleDriftSignal(proxy([0.99, 0.99, 0.99]), rank([26, 28, 30]));
      expect(sig!.stagnantCycles).toBe(2);
      expect(detectOracleDrift(sig).level).toBe('reanchor');
    });

    test('missing history (either series < 2 points) yields no signal (silent-safe)', () => {
      expect(computeOracleDriftSignal(proxy([0.99]), rank([26, 26, 26]))).toBeUndefined();
      expect(computeOracleDriftSignal(proxy([0.98, 0.99]), rank([26]))).toBeUndefined();
      expect(computeOracleDriftSignal(proxy([]), rank([]))).toBeUndefined();
      // signal 無し → detectOracleDrift は none（バナー不発火）。
      expect(detectOracleDrift(undefined).level).toBe('none');
    });

    test('only the trailing consecutive drift steps count toward stagnantCycles', () => {
      // 最古ステップは proxy 改善大(0.70→0.90)で drift でない → 末尾2ステップ(微増<0.005)のみ計上。
      const sig = computeOracleDriftSignal(proxy([0.7, 0.9, 0.902, 0.903]), rank([50, 40, 40, 40]));
      expect(sig!.stagnantCycles).toBe(2);
    });
  });
});
