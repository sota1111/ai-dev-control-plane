import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTargetsRegistry,
  resolveCompetitionForHour,
  getCompetition,
  isScheduledHour,
  buildIssueTitle,
  buildIssueBody,
  planImprovementCycle,
  planChampionSubmission,
  planCompetitionSubmission,
  nextAlternateLineage,
  alternateLineageForUtcDate,
  type TargetsRegistry,
  type CycleInput,
} from '../lib/kaggleImprovement.js';

// SOT-1913 / SOT-1932 — Kaggle 改善サイクル起案エンジン。
describe('kaggleImprovement', () => {
  const rawRegistry = {
    __doc__: 'ignored',
    enabled: false,
    schedule_hours_jst: [0, 4, 8, 12, 16, 20],
    rotation: [
      { hour_jst: 0, competition: 'ptcg' },
      { hour_jst: 4, competition: 'arc-agi-2' },
    ],
    issue_cap_guard: 240,
    competitions: [
      {
        key: 'ptcg',
        kaggle_competition: 'pokemon-tcg-ai-battle',
        daily_submission_cap: 5,
        targets: [
          {
            lineage: 'claude',
            repo: 'ptcg-agent-claude',
            project: 'ptcg-agent-claude',
            workers_directive: 'solo=claude:opus, handoff=off',
            submit: { file: '', message: 'm' },
            next_cycle: 3,
          },
          {
            lineage: 'gpt',
            repo: 'ptcg-agent-gpt',
            project: 'ptcg-agent-gpt',
            workers_directive: 'solo=codex:gpt-5.6-sol, handoff=off',
            next_cycle: 1,
          },
        ],
      },
      {
        key: 'arc-agi-2',
        kaggle_competition: 'arc-prize-2026',
        daily_submission_cap: 1,
        submission_mode: 'alternate',
        alternate_anchor_date: '2026-07-29',
        alternate_anchor_lineage: 'claude',
        targets: [
          {
            lineage: 'claude',
            repo: 'arc-agi-2-claude',
            project: 'arc-agi-2-claude',
            workers_directive: 'solo=claude:opus, handoff=off',
            submit: { file: 'submission/claude.json', message: 'm' },
            next_cycle: 1,
          },
          {
            lineage: 'gpt',
            repo: 'arc-agi-2-gpt',
            project: 'arc-agi-2-gpt',
            workers_directive: 'solo=codex:gpt-5.6-sol, handoff=off',
            submit: { file: 'submission/gpt.json', message: 'm' },
            next_cycle: 1,
          },
        ],
      },
    ],
  };

  const reg = (): TargetsRegistry => parseTargetsRegistry(rawRegistry);

  const baseInput = (over: Partial<CycleInput> = {}): CycleInput => ({
    registry: reg(),
    hourJst: 0,
    envEnabled: true,
    issueCount: 10,
    cooldownActive: false,
    ...over,
  });

  describe('parseTargetsRegistry', () => {
    test('parses valid registry and ignores __ keys', () => {
      const r = reg();
      expect(r.enabled).toBe(false);
      expect(r.scheduleHoursJst).toEqual([0, 4, 8, 12, 16, 20]);
      expect(r.rotation).toHaveLength(2);
      expect(r.issueCapGuard).toBe(240);
      expect(r.competitions).toHaveLength(2);
      expect(r.competitions[0].targets[0]).toMatchObject({
        lineage: 'claude',
        repo: 'ptcg-agent-claude',
        nextCycle: 3,
      });
    });

    test('normalizes schedule hours (dedupe + sort)', () => {
      const r = parseTargetsRegistry({
        ...rawRegistry,
        schedule_hours_jst: [8, 0, 8, 4],
      });
      expect(r.scheduleHoursJst).toEqual([0, 4, 8]);
    });

    test('rejects non-boolean enabled', () => {
      expect(() => parseTargetsRegistry({ ...rawRegistry, enabled: 'no' })).toThrow(/enabled/);
    });

    test('rejects duplicate rotation hour', () => {
      expect(() =>
        parseTargetsRegistry({
          ...rawRegistry,
          rotation: [
            { hour_jst: 0, competition: 'ptcg' },
            { hour_jst: 0, competition: 'arc-agi-2' },
          ],
        })
      ).toThrow(/duplicated/);
    });

    test('rejects rotation referencing unknown competition', () => {
      expect(() =>
        parseTargetsRegistry({
          ...rawRegistry,
          rotation: [{ hour_jst: 0, competition: 'nope' }],
        })
      ).toThrow(/unknown competition/);
    });

    test('rejects duplicate competition key', () => {
      expect(() =>
        parseTargetsRegistry({
          ...rawRegistry,
          competitions: [rawRegistry.competitions[0], rawRegistry.competitions[0]],
        })
      ).toThrow(/duplicated/);
    });

    test('rejects invalid lineage', () => {
      const bad = JSON.parse(JSON.stringify(rawRegistry));
      bad.competitions[0].targets[0].lineage = 'sol';
      expect(() => parseTargetsRegistry(bad)).toThrow(/lineage/);
    });

    test('rejects duplicate lineage within a competition', () => {
      const bad = JSON.parse(JSON.stringify(rawRegistry));
      bad.competitions[0].targets[1].lineage = 'claude';
      expect(() => parseTargetsRegistry(bad)).toThrow(/duplicated/);
    });

    test('submission_mode defaults to "both" and parses "alternate"', () => {
      const r = reg();
      expect(getCompetition(r, 'ptcg')!.submissionMode).toBe('both'); // 未指定 → both
      expect(getCompetition(r, 'arc-agi-2')!.submissionMode).toBe('alternate');
    });

    test('rejects invalid submission_mode', () => {
      const bad = JSON.parse(JSON.stringify(rawRegistry));
      bad.competitions[0].submission_mode = 'solo';
      expect(() => parseTargetsRegistry(bad)).toThrow(/submission_mode/);
    });

    test('daily submissions per lineage defaults to one and validates against the cap', () => {
      expect(reg().competitions[0].dailySubmissionsPerLineage).toBe(1);
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].daily_submissions_per_lineage = 2;
      expect(parseTargetsRegistry(raw).competitions[0].dailySubmissionsPerLineage).toBe(2);
      raw.competitions[0].daily_submissions_per_lineage = 6;
      expect(() => parseTargetsRegistry(raw)).toThrow(/daily_submissions_per_lineage/);
    });

    test('parses a fixed four-condition evaluation contract', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].ab_evaluation = {
        game_ids: ['ls20', 'ft09'],
        action_budget: 100,
        trials_per_game: 3,
        seed: 2191,
        guardrails: {
          max_total_tokens_ratio: 1.1,
          max_api_cost_ratio: 1.1,
          max_latency_ratio: 1.2,
        },
      };
      expect(parseTargetsRegistry(raw).competitions[0].abEvaluation).toMatchObject({
        gameIds: ['ls20', 'ft09'],
        actionBudget: 100,
        trialsPerGame: 3,
      });
    });
  });

  describe('rotation resolution', () => {
    test('resolveCompetitionForHour maps slot to competition', () => {
      const r = reg();
      expect(resolveCompetitionForHour(r, 0)).toBe('ptcg');
      expect(resolveCompetitionForHour(r, 4)).toBe('arc-agi-2');
      expect(resolveCompetitionForHour(r, 12)).toBeNull();
    });

    test('isScheduledHour reflects schedule', () => {
      const r = reg();
      expect(isScheduledHour(r, 12)).toBe(true);
      expect(isScheduledHour(r, 3)).toBe(false);
    });

    test('getCompetition finds by key', () => {
      const r = reg();
      expect(getCompetition(r, 'arc-agi-2')?.kaggleCompetition).toBe('arc-prize-2026');
      expect(getCompetition(r, 'missing')).toBeUndefined();
    });
  });

  describe('issue body/title', () => {
    test('buildIssueTitle is feature-first with cycle number', () => {
      const t = reg().competitions[0].targets[0];
      expect(buildIssueTitle(t, 3)).toBe(
        '[ptcg-agent-claude] Kaggle順位向上サイクル第3次 — 改善方針の立案と実施'
      );
    });

    test('buildIssueBody embeds directive and material digests', () => {
      const c = reg().competitions[0];
      const body = buildIssueBody(c.targets[0], c, 3, {
        previousSubmission: 'rank 42 / score 571.8',
        recentIssuesDigest: 'SOT-1866 champion 収束',
      });
      expect(body).toContain('workers: solo=claude:opus, handoff=off');
      expect(body).toContain('pokemon-tcg-ai-battle');
      expect(body).toContain('rank 42 / score 571.8');
      expect(body).toContain('SOT-1866 champion 収束');
      expect(body).toContain('改善の実装・学習・検証では GPU の使用を許可する。');
      expect(body).toContain('改善方針の検討では Kaggle の公開ノートブック等を参考にしてよい。');
      // 未指定の材料は安全側のプレースホルダになる。
      expect(body).toContain('(該当なし)');
    });

    test('embeds A/B telemetry, chain isolation and automatic continuation', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].ab_evaluation = {
        game_ids: ['ls20'],
        action_budget: 100,
        trials_per_game: 3,
        seed: 2191,
        guardrails: {
          max_total_tokens_ratio: 1.1,
          max_api_cost_ratio: 1.1,
          max_latency_ratio: 1.2,
        },
      };
      const competition = parseTargetsRegistry(raw).competitions[0];
      const body = buildIssueBody(competition.targets[0], competition, 3, {});
      expect(body).toContain('baseline / retained reasoningのみ / compactionのみ / 両方');
      expect(body).toContain('input・output・reasoning tokens');
      expect(body).toContain('日次・Issue間へ持ち越さない');
      expect(body).toContain('次回改善Issueは自動処理が冪等キー付きで登録');
    });
  });

  describe('planImprovementCycle guards', () => {
    test('inactive when registry disabled even if env enabled', () => {
      const plan = planImprovementCycle(baseInput({ registry: reg() /* enabled:false */ }));
      expect(plan.active).toBe(false);
      expect(plan.targets).toHaveLength(0);
      expect(plan.reason).toMatch(/disabled/);
    });

    const enabledReg = (): TargetsRegistry =>
      parseTargetsRegistry({ ...rawRegistry, enabled: true });

    test('drafts both on-duty targets when all guards pass', () => {
      const plan = planImprovementCycle(
        baseInput({
          registry: enabledReg(),
          hourJst: 0,
          material: {
            'ptcg-agent-claude': { previousSubmission: 'rank 40' },
          },
        })
      );
      expect(plan.active).toBe(true);
      expect(plan.competition).toBe('ptcg');
      expect(plan.targets).toHaveLength(2);
      expect(plan.targets.every((t) => t.action === 'draft')).toBe(true);
      // claude ターゲットは nextCycle=3、gpt=1 が使われる。
      const claude = plan.targets.find((t) => t.lineage === 'claude')!;
      expect(claude.cycleNumber).toBe(3);
      expect(claude.issueBody).toContain('rank 40');
      expect(plan.targets.find((t) => t.lineage === 'gpt')!.cycleNumber).toBe(1);
    });

    test('skips slot with no competition', () => {
      const plan = planImprovementCycle(baseInput({ registry: enabledReg(), hourJst: 8 }));
      expect(plan.active).toBe(true);
      expect(plan.competition).toBeNull();
      expect(plan.targets).toHaveLength(0);
      expect(plan.reason).toMatch(/no competition scheduled/);
    });

    test('issue cap guard skips all targets', () => {
      const plan = planImprovementCycle(
        baseInput({ registry: enabledReg(), hourJst: 0, issueCount: 240 })
      );
      expect(plan.targets).toHaveLength(2);
      expect(plan.targets.every((t) => t.action === 'skip')).toBe(true);
      expect(plan.targets[0].reason).toMatch(/issue cap guard/);
    });

    test('cooldown guard skips all targets', () => {
      const plan = planImprovementCycle(
        baseInput({ registry: enabledReg(), hourJst: 0, cooldownActive: true })
      );
      expect(plan.targets.every((t) => t.action === 'skip')).toBe(true);
      expect(plan.targets[0].reason).toMatch(/cooldown/);
    });

    test('unfinished-cycle guard skips only the affected project', () => {
      const plan = planImprovementCycle(
        baseInput({
          registry: enabledReg(),
          hourJst: 0,
          signals: {
            'ptcg-agent-claude': { hasUnfinishedCycle: true, hasNewMaterial: true },
          },
        })
      );
      const claude = plan.targets.find((t) => t.project === 'ptcg-agent-claude')!;
      const gpt = plan.targets.find((t) => t.project === 'ptcg-agent-gpt')!;
      expect(claude.action).toBe('skip');
      expect(claude.reason).toMatch(/still open/);
      // シグナル未指定の gpt は安全側デフォルト（新材料あり）で draft される。
      expect(gpt.action).toBe('draft');
    });

    test('no-new-material guard skips the project', () => {
      const plan = planImprovementCycle(
        baseInput({
          registry: enabledReg(),
          hourJst: 0,
          signals: {
            'ptcg-agent-claude': { hasUnfinishedCycle: false, hasNewMaterial: false },
          },
        })
      );
      const claude = plan.targets.find((t) => t.project === 'ptcg-agent-claude')!;
      expect(claude.action).toBe('skip');
      expect(claude.reason).toMatch(/no new material/);
    });

    test('measurement health guard suppresses blind drafting before plateau/material guards', () => {
      const plan = planImprovementCycle(
        baseInput({
          registry: enabledReg(),
          hourJst: 0,
          signals: {
            'ptcg-agent-claude': {
              hasUnfinishedCycle: false,
              hasNewMaterial: true,
              plateauReason: 'plateau escalation: stale method',
              measurementFailureReason:
                'measurement unavailable: Kaggle CLI authentication failed; verify cron credentials/API token',
            },
          },
        })
      );
      const target = plan.targets.find((t) => t.project === 'ptcg-agent-claude');
      expect(target?.action).toBe('skip');
      expect(target?.reason).toContain('authentication failed');
    });

    test('plateau escalation stops drafting with an actionable reason', () => {
      const plan = planImprovementCycle(
        baseInput({
          registry: enabledReg(),
          hourJst: 0,
          signals: {
            'ptcg-agent-claude': {
              hasUnfinishedCycle: false,
              hasNewMaterial: true,
              plateauReason:
                'plateau escalation: ptcg-agent-claude has 3 consecutive non-improving scores',
            },
          },
        })
      );
      const claude = plan.targets.find((t) => t.project === 'ptcg-agent-claude')!;
      expect(claude.action).toBe('skip');
      expect(claude.reason).toMatch(/plateau escalation/);
    });
  });

  // SOT-1934 — 完了トリガの champion 提出（コンペ内収束/選定なし）。
  describe('planChampionSubmission', () => {
    const ptcg = () => getCompetition(reg(), 'ptcg')!;
    const claudeTarget = () => ptcg().targets.find((t) => t.lineage === 'claude')!; // submit.file = ''
    const gptTarget = () => {
      const t = ptcg().targets.find((t) => t.lineage === 'gpt')!;
      return { ...t, submit: { file: 'submission/main.py', message: 'm' } };
    };

    test('submits the current champion when a submit.file exists and none submitted today', () => {
      const p = planChampionSubmission(ptcg(), gptTarget(), 0);
      expect(p.action).toBe('submit');
      expect(p.file).toBe('submission/main.py');
      expect(p.reason).toMatch(/no in-competition selection gate/);
    });

    test('is idempotent per day — skips when already submitted today (no double submit)', () => {
      const p = planChampionSubmission(ptcg(), gptTarget(), 1);
      expect(p.action).toBe('skip');
      expect(p.reason).toMatch(/daily lineage target reached/);
    });

    test('skips + (caller notifies) when submit.file is not configured', () => {
      const p = planChampionSubmission(ptcg(), claudeTarget(), 0);
      expect(p.action).toBe('skip');
      expect(p.reason).toMatch(/no submit\.file/);
    });

    test('planCompetitionSubmission covers both lineages of the on-duty competition', () => {
      const plan = planCompetitionSubmission(reg(), 'ptcg', {});
      expect(plan).not.toBeNull();
      expect(plan!.targets.map((t) => t.lineage).sort()).toEqual(['claude', 'gpt']);
      // both default to 0 submitted today; claude has no file → skip, gpt (registry file empty) → skip too.
      expect(plan!.targets.every((t) => t.action === 'skip')).toBe(true);
    });

    test('planCompetitionSubmission returns null for an unknown competition', () => {
      expect(planCompetitionSubmission(reg(), 'nope', {})).toBeNull();
    });

    test('both-mode plan carries mode="both" and no chosenLineage', () => {
      const plan = planCompetitionSubmission(reg(), 'ptcg', {})!;
      expect(plan.mode).toBe('both');
      expect(plan.chosenLineage).toBeUndefined();
    });
  });

  // SOT-1913 提出cap補正 — ARC(1/day 共有)は claude/gpt を日替わり交互提出。
  describe('alternate submission mode (ARC 1/day shared cap)', () => {
    test('nextAlternateLineage flips lineage; defaults to claude when unknown', () => {
      expect(nextAlternateLineage(undefined)).toBe('claude');
      expect(nextAlternateLineage(null)).toBe('claude');
      expect(nextAlternateLineage('claude')).toBe('gpt');
      expect(nextAlternateLineage('gpt')).toBe('claude');
    });

    test('calendar anchor flips lineage on each UTC date', () => {
      expect(alternateLineageForUtcDate('2026-07-29', '2026-07-29', 'gpt')).toBe('gpt');
      expect(alternateLineageForUtcDate('2026-07-30', '2026-07-29', 'gpt')).toBe('claude');
      expect(alternateLineageForUtcDate('2026-07-31', '2026-07-29', 'gpt')).toBe('gpt');
      expect(() => alternateLineageForUtcDate('2026-02-30', '2026-07-29', 'gpt')).toThrow(
        /invalid/
      );
    });

    test('first time (no prior submission) submits claude, gpt waits its turn', () => {
      const plan = planCompetitionSubmission(
        reg(),
        'arc-agi-2',
        {},
        {
          dateUtc: '2026-07-29',
        }
      )!;
      expect(plan.mode).toBe('alternate');
      expect(plan.chosenLineage).toBe('claude');
      const claude = plan.targets.find((t) => t.lineage === 'claude')!;
      const gpt = plan.targets.find((t) => t.lineage === 'gpt')!;
      expect(claude.action).toBe('submit');
      expect(claude.file).toBe('submission/claude.json');
      expect(gpt.action).toBe('skip');
      expect(gpt.reason).toMatch(/alternate mode/);
    });

    test('the next UTC date switches from claude to gpt regardless of submission history', () => {
      const plan = planCompetitionSubmission(
        reg(),
        'arc-agi-2',
        {},
        {
          lastSubmittedLineage: 'gpt',
          dateUtc: '2026-07-30',
        }
      )!;
      expect(plan.chosenLineage).toBe('gpt');
      const gpt = plan.targets.find((t) => t.lineage === 'gpt')!;
      const claude = plan.targets.find((t) => t.lineage === 'claude')!;
      expect(gpt.action).toBe('submit');
      expect(claude.action).toBe('skip');
    });

    test('shared cap: if either lineage already submitted today, the chosen one skips (idempotent)', () => {
      // gpt is this turn (claude went last) but claude already used today\'s single slot.
      const plan = planCompetitionSubmission(
        reg(),
        'arc-agi-2',
        { 'arc-agi-2-claude': 1 },
        { dateUtc: '2026-07-30' }
      )!;
      expect(plan.chosenLineage).toBe('gpt');
      const gpt = plan.targets.find((t) => t.lineage === 'gpt')!;
      expect(gpt.action).toBe('skip');
      expect(gpt.reason).toMatch(/daily cap reached/);
    });

    test('both mode can accept two daily submissions per lineage', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].daily_submissions_per_lineage = 2;
      raw.competitions[0].targets[0].submit = { file: 'submission/claude.py', message: 'm' };
      raw.competitions[0].targets[1].submit = { file: 'submission/gpt.py', message: 'm' };
      const registry = parseTargetsRegistry(raw);
      expect(
        planCompetitionSubmission(registry, 'ptcg', {
          'ptcg-agent-claude': 1,
          'ptcg-agent-gpt': 1,
        })!.targets.every((target) => target.action === 'submit')
      ).toBe(true);
      expect(
        planCompetitionSubmission(registry, 'ptcg', {
          'ptcg-agent-claude': 2,
          'ptcg-agent-gpt': 2,
        })!.targets.every((target) => target.action === 'skip')
      ).toBe(true);
    });
  });

  describe('shipped registry file', () => {
    test('scripts/ai/kaggle_targets_registry.json parses and includes Kaggriculture lineages', () => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const p = path.join(here, '..', '..', 'scripts', 'ai', 'kaggle_targets_registry.json');
      const r = parseTargetsRegistry(JSON.parse(fs.readFileSync(p, 'utf8')));
      expect(r.enabled).toBe(false);
      expect(r.competitions).toHaveLength(7);
      expect(r.rotation).toHaveLength(8);
      // 各コンペは claude/gpt の2ターゲットを持つ。
      for (const c of r.competitions) {
        expect(c.targets.map((t) => t.lineage).sort()).toEqual(['claude', 'gpt']);
      }
      expect(r.competitions.find((c) => c.key === 'kaggriculture')).toMatchObject({
        kaggleCompetition: 'kaggriculture',
        dailySubmissionCap: 5,
        dailySubmissionsPerLineage: 2,
        submissionMode: 'both',
      });
      expect(r.competitions.find((c) => c.key === 'agent-security')).toMatchObject({
        kaggleCompetition: 'ai-agent-security-multi-step-tool-attacks',
        dailySubmissionCap: 5,
        dailySubmissionsPerLineage: 2,
        submissionMode: 'both',
      });
      // SOT-1913 提出cap補正: ARC=1/day & alternate、他=5/day & both。
      for (const c of r.competitions) {
        const isArc = c.key === 'arc-agi-2' || c.key === 'arc-agi-3';
        if (isArc) {
          expect(c.dailySubmissionCap).toBe(1);
          expect(c.submissionMode).toBe('alternate');
        } else {
          expect(c.dailySubmissionCap).toBe(5);
          expect(c.submissionMode).toBe('both');
        }
      }
    });
  });
});
