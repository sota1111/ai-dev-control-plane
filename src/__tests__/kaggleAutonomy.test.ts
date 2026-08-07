import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseTargetsRegistry,
  resolveCompetitionPhase,
  planImprovementCycle,
  buildIssueBody,
  type TargetsRegistry,
} from '../lib/kaggleImprovement.js';
import {
  computePublicRank,
  appendLeaderboardRank,
  readLeaderboardRankHistory,
  leaderboardRankFingerprint,
  type LeaderboardRankEntry,
} from '../lib/kaggleScoreProgression.js';
import { parseKaggleLeaderboardScores, bestPublicScoreFromRows } from '../lib/kaggleImproveMaterial.js';

function rawRegistry(overrides: Record<string, unknown> = {}, targetOverrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    schedule_hours_jst: [0],
    rotation: [{ hour_jst: 0, competition: 'ptcg' }],
    issue_cap_guard: 240,
    competitions: [
      {
        key: 'ptcg',
        kaggle_competition: 'pokemon-tcg-ai-battle',
        daily_submission_cap: 5,
        daily_submissions_per_lineage: 2,
        submission_mode: 'both',
        ...overrides,
        targets: [
          {
            lineage: 'claude',
            repo: 'ptcg-agent-claude',
            project: 'ptcg-agent-claude',
            workers_directive: 'solo=claude:fable, handoff=off',
            next_cycle: 5,
            ...targetOverrides,
          },
        ],
      },
    ],
  };
}

describe('kaggle autonomy — registry schema additions', () => {
  it('defaults: no deadline, finalWindowDays=7, scoreDirection=max, target mode=improve', () => {
    const reg = parseTargetsRegistry(rawRegistry());
    const comp = reg.competitions[0];
    expect(comp.deadlineUtc).toBeUndefined();
    expect(comp.finalWindowDays).toBe(7);
    expect(comp.scoreDirection).toBe('max');
    expect(comp.targets[0].mode).toBe('improve');
  });

  it('parses deadline_utc / final_window_days / score_direction / target mode', () => {
    const reg = parseTargetsRegistry(rawRegistry(
      { deadline_utc: '2026-09-30', final_window_days: 10, score_direction: 'min' },
      { mode: 'maintain' }
    ));
    const comp = reg.competitions[0];
    expect(comp.deadlineUtc).toBe('2026-09-30');
    expect(comp.finalWindowDays).toBe(10);
    expect(comp.scoreDirection).toBe('min');
    expect(comp.targets[0].mode).toBe('maintain');
  });

  it('defaults allocation to static (legacy rotation) when the block is absent', () => {
    const reg = parseTargetsRegistry(rawRegistry());
    expect(reg.allocation.mode).toBe('static');
    expect(reg.allocation.autoMaintainThreshold).toBe(0);
  });

  it('parses a dynamic allocation block', () => {
    const raw = rawRegistry();
    (raw as any).allocation = { mode: 'dynamic', auto_maintain_threshold: 6 };
    const reg = parseTargetsRegistry(raw);
    expect(reg.allocation.mode).toBe('dynamic');
    expect(reg.allocation.autoMaintainThreshold).toBe(6);
  });

  it('rejects invalid values (fail-loud)', () => {
    expect(() => parseTargetsRegistry(rawRegistry({ deadline_utc: 'not-a-date' }))).toThrow(/deadline_utc/);
    expect(() => parseTargetsRegistry(rawRegistry({ final_window_days: -1 }))).toThrow(/final_window_days/);
    expect(() => parseTargetsRegistry(rawRegistry({ score_direction: 'up' }))).toThrow(/score_direction/);
    expect(() => parseTargetsRegistry(rawRegistry({}, { mode: 'paused' }))).toThrow(/mode/);
  });
});

describe('kaggle autonomy — resolveCompetitionPhase', () => {
  it('is explore without a deadline', () => {
    expect(resolveCompetitionPhase({ finalWindowDays: 7 }, '2026-08-02T00:00:00Z').phase).toBe('explore');
  });

  it('switches explore → converge → closed around the deadline', () => {
    const comp = { deadlineUtc: '2026-08-10', finalWindowDays: 7 };
    expect(resolveCompetitionPhase(comp, '2026-08-01T00:00:00Z').phase).toBe('explore');
    expect(resolveCompetitionPhase(comp, '2026-08-05T00:00:00Z').phase).toBe('converge');
    expect(resolveCompetitionPhase(comp, '2026-08-11T12:00:00Z').phase).toBe('closed');
  });
});

describe('kaggle autonomy — planImprovementCycle strategy gates', () => {
  const baseInput = (registry: TargetsRegistry, nowUtc: string) => ({
    registry,
    hourJst: 0,
    envEnabled: true,
    nowUtc,
  });

  it('skips a maintain-mode target (saturated lineage — resources reallocated)', () => {
    const reg = parseTargetsRegistry(rawRegistry({}, { mode: 'maintain' }));
    const plan = planImprovementCycle(baseInput(reg, '2026-08-02T00:00:00Z'));
    expect(plan.targets[0].action).toBe('skip');
    expect(plan.targets[0].reason).toContain('maintenance mode');
  });

  it('skips drafting after the competition deadline', () => {
    const reg = parseTargetsRegistry(rawRegistry({ deadline_utc: '2026-08-01' }));
    const plan = planImprovementCycle(baseInput(reg, '2026-08-02T12:00:00Z'));
    expect(plan.targets[0].action).toBe('skip');
    expect(plan.targets[0].reason).toContain('deadline passed');
  });

  it('drafts with a converge-mode issue body inside the final window', () => {
    const reg = parseTargetsRegistry(rawRegistry({ deadline_utc: '2026-08-08' }));
    const plan = planImprovementCycle(baseInput(reg, '2026-08-02T00:00:00Z'));
    expect(plan.targets[0].action).toBe('draft');
    expect(plan.targets[0].issueBody).toContain('## 収束モード');
    expect(plan.targets[0].issueBody).toContain('新規の改善軸は起案しない');
  });

  it('still drafts normally (explore) and embeds LB/ledger material sections', () => {
    const reg = parseTargetsRegistry(rawRegistry());
    const plan = planImprovementCycle({
      ...baseInput(reg, '2026-08-02T00:00:00Z'),
      material: {
        'ptcg-agent-claude': {
          leaderboardSummary: '- 現在順位(公開LB): 12位 / 表示50チーム',
          experimentLedgerDigest: '非昇格（新しい根拠なしの再試行は禁止）:\n- belief-width',
        },
      },
    });
    const body = plan.targets[0].issueBody!;
    expect(plan.targets[0].action).toBe('draft');
    // SOT-2513: 一次=leak-free CV / 二次=public LB(sanity)。旧「一次KPI=LB順位」ヘッダは廃止。
    expect(body).not.toContain('### Leaderboard 順位（一次KPI）');
    expect(body).toContain('### 検証階層（一次=leak-free CV / 二次=public LB）');
    expect(body).toContain('12位 / 表示50チーム');
    expect(body).toContain('### 実験台帳ダイジェスト');
    expect(body).toContain('belief-width');
    expect(body).toContain('escalation ladder');
    expect(body).not.toContain('## 収束モード');
  });
});

describe('kaggle autonomy — computePublicRank', () => {
  it('computes 1-based rank among listed scores (max direction)', () => {
    const standing = computePublicRank([600, 550, 500, 450], 520, 'max');
    expect(standing.rank).toBe(3);
    expect(standing.totalListed).toBe(4);
    expect(standing.topScore).toBe(600);
    expect(standing.gapToTop).toBe(80);
  });

  it('supports min direction (lower is better)', () => {
    const standing = computePublicRank([0.1, 0.2, 0.3], 0.15, 'min');
    expect(standing.rank).toBe(2);
    expect(standing.topScore).toBe(0.1);
  });

  it('returns rank=null when our score is below every listed row (truncated top-N)', () => {
    const standing = computePublicRank([600, 550, 500], 400, 'max');
    expect(standing.rank).toBeNull();
    expect(standing.topScore).toBe(600);
  });

  it('handles empty leaderboards', () => {
    expect(computePublicRank([], 100, 'max').rank).toBeNull();
  });
});

describe('kaggle autonomy — bestPublicScoreFromRows (LB rank no longer depends on score-progression)', () => {
  it('takes the max COMPLETE public score from raw submission rows', () => {
    const rows = [
      { status: 'complete', publicScore: '410.1' },
      { status: 'complete', publicScore: '520.7' },
      { status: 'pending', publicScore: '' },
      { status: 'error', publicScore: '999' },
    ];
    expect(bestPublicScoreFromRows(rows, 'max')).toBe(520.7);
  });

  it('takes the min for min-direction competitions', () => {
    const rows = [
      { status: 'complete', publicScore: '0.30' },
      { status: 'complete', publicScore: '0.12' },
    ];
    expect(bestPublicScoreFromRows(rows, 'min')).toBe(0.12);
  });

  it('ignores non-COMPLETE and non-numeric rows, returns undefined when none qualify', () => {
    expect(bestPublicScoreFromRows([{ status: 'pending', publicScore: '' }], 'max')).toBeUndefined();
    expect(bestPublicScoreFromRows([], 'max')).toBeUndefined();
  });
});

describe('kaggle autonomy — leaderboard CSV parsing and rank history', () => {
  it('parses the score column by header name and ignores warning lines', () => {
    const csv = [
      'Warning: Looks like you are using an outdated API',
      'teamId,teamName,submissionDate,score',
      '1,alpha,2026-08-01 00:00:00,600.5',
      '2,beta,2026-08-01 01:00:00,550.0',
      '3,gamma,2026-08-01 02:00:00,not-a-number',
    ].join('\n');
    expect(parseKaggleLeaderboardScores(csv)).toEqual([600.5, 550.0]);
  });

  it('appends rank history idempotently (one observation per repo per UTC day)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-rank-'));
    const file = path.join(dir, 'leaderboard-rank.jsonl');
    try {
      const entry: LeaderboardRankEntry = {
        observedAt: '2026-08-02T03:00:00Z',
        competition: 'ptcg',
        kaggleCompetition: 'pokemon-tcg-ai-battle',
        repo: 'ptcg-agent-claude',
        lineage: 'claude',
        bestPublicScore: 520,
        rank: 3,
        totalListed: 50,
        fingerprint: leaderboardRankFingerprint('ptcg', 'ptcg-agent-claude', '2026-08-02T03:00:00Z'),
      };
      expect(appendLeaderboardRank(file, [entry])).toBe(1);
      // Same UTC day → deduped even at a different time.
      expect(appendLeaderboardRank(file, [{
        ...entry,
        observedAt: '2026-08-02T15:00:00Z',
        fingerprint: leaderboardRankFingerprint('ptcg', 'ptcg-agent-claude', '2026-08-02T15:00:00Z'),
      }])).toBe(0);
      // Next day → appended.
      expect(appendLeaderboardRank(file, [{
        ...entry,
        observedAt: '2026-08-03T03:00:00Z',
        rank: 2,
        fingerprint: leaderboardRankFingerprint('ptcg', 'ptcg-agent-claude', '2026-08-03T03:00:00Z'),
      }])).toBe(1);
      expect(readLeaderboardRankHistory(file).map((e) => e.rank)).toEqual([3, 2]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
