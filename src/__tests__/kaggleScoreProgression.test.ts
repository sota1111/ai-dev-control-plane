import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendNewScoreProgression,
  detectScorePlateau,
  progressionEntriesFromRows,
  readScoreProgression,
  type ScoreProgressionEntry,
} from '../lib/kaggleScoreProgression.js';
import { parseTargetsRegistry } from '../lib/kaggleImprovement.js';

const competition = parseTargetsRegistry({
  enabled: true,
  schedule_hours_jst: [0],
  rotation: [{ hour_jst: 0, competition: 'demo' }],
  issue_cap_guard: 240,
  competitions: [{
    key: 'demo',
    kaggle_competition: 'owner/demo',
    daily_submission_cap: 5,
    targets: [
      {
        lineage: 'claude',
        repo: 'demo-claude',
        project: 'demo-claude',
        workers_directive: 'solo=claude',
        next_cycle: 1,
      },
      {
        lineage: 'gpt',
        repo: 'demo-gpt',
        project: 'demo-gpt',
        workers_directive: 'solo=codex',
        next_cycle: 1,
      },
    ],
  }],
}).competitions[0];

describe('kaggleScoreProgression', () => {
  test('turns completed scored rows into target-attributed entries', () => {
    const entries = progressionEntriesFromRows(competition, [
      {
        fileName: 'submission.csv',
        date: '2026-07-29 00:00:00',
        description: 'auto-improve submit: demo-claude champion',
        status: 'complete',
        publicScore: '0.51',
      },
      {
        date: '2026-07-29 01:00:00',
        description: 'demo-gpt',
        status: 'pending',
        publicScore: '0.52',
      },
      {
        date: '2026-07-29 02:00:00',
        description: 'unattributed',
        status: 'complete',
        publicScore: '0.53',
      },
    ], '2026-07-30T00:00:00Z');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      competition: 'demo',
      repo: 'demo-claude',
      lineage: 'claude',
      publicScore: 0.51,
    });
  });

  test('append is idempotent by submission fingerprint and tolerates malformed old lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-progression-'));
    const file = path.join(dir, 'score-progression.jsonl');
    fs.writeFileSync(file, '{bad json}\n');
    const [entry] = progressionEntriesFromRows(competition, [{
      fileName: 'submission.csv',
      date: '2026-07-29 00:00:00',
      description: 'demo-claude champion',
      status: 'complete',
      publicScore: '0.51',
    }]);
    expect(appendNewScoreProgression(file, [entry])).toBe(1);
    expect(appendNewScoreProgression(file, [entry])).toBe(0);
    expect(readScoreProgression(file)).toHaveLength(1);
  });

  test('the same submission remains deduplicated when observed again later', () => {
    const row = {
      fileName: 'submission.csv',
      date: '2026-07-29 00:00:00',
      description: 'demo-claude champion',
      status: 'complete',
      publicScore: '0.51',
    };
    const first = progressionEntriesFromRows(competition, [row], '2026-07-29T01:00:00Z')[0];
    const later = progressionEntriesFromRows(competition, [row], '2026-07-30T01:00:00Z')[0];
    expect(first.fingerprint).toBe(later.fingerprint);
  });

  test('escalates only after threshold non-improvements with the same approach', () => {
    const entry = (
      submissionDate: string,
      publicScore: number,
      approach = 'same champion'
    ): ScoreProgressionEntry => ({
      observedAt: `${submissionDate}Z`,
      competition: 'demo',
      kaggleCompetition: 'owner/demo',
      repo: 'demo-claude',
      lineage: 'claude',
      submissionDate,
      publicScore,
      approach,
      fingerprint: `${submissionDate}|${publicScore}`,
    });
    const history = [
      entry('2026-07-25T00:00:00', 0.5),
      entry('2026-07-26T00:00:00', 0.5),
      entry('2026-07-27T00:00:00', 0.49),
      entry('2026-07-28T00:00:00', 0.5),
    ];
    const plateau = detectScorePlateau(history, 'demo-claude', 3);
    expect(plateau.plateau).toBe(true);
    expect(plateau.consecutiveNonImproving).toBe(3);
    expect(plateau.reason).toContain('plateau escalation');
  });

  test('a new best or a changed approach resets the non-improvement streak', () => {
    const base: Omit<ScoreProgressionEntry, 'submissionDate' | 'publicScore' | 'approach' | 'fingerprint'> = {
      observedAt: '2026-07-30T00:00:00Z',
      competition: 'demo',
      kaggleCompetition: 'owner/demo',
      repo: 'demo-claude',
      lineage: 'claude',
    };
    const rows = [
      { ...base, submissionDate: '2026-07-25', publicScore: 0.5, approach: 'a', fingerprint: '1' },
      { ...base, submissionDate: '2026-07-26', publicScore: 0.4, approach: 'a', fingerprint: '2' },
      { ...base, submissionDate: '2026-07-27', publicScore: 0.4, approach: 'b', fingerprint: '3' },
      { ...base, submissionDate: '2026-07-28', publicScore: 0.6, approach: 'b', fingerprint: '4' },
    ];
    expect(detectScorePlateau(rows, 'demo-claude', 2)).toMatchObject({
      plateau: false,
      consecutiveNonImproving: 0,
      bestScore: 0.6,
    });
  });
});
