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
        targets: [
          {
            lineage: 'claude',
            repo: 'arc-agi-2-claude',
            project: 'arc-agi-2-claude',
            workers_directive: 'solo=claude:opus, handoff=off',
            next_cycle: 1,
          },
          {
            lineage: 'gpt',
            repo: 'arc-agi-2-gpt',
            project: 'arc-agi-2-gpt',
            workers_directive: 'solo=codex:gpt-5.6-sol, handoff=off',
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
      // 未指定の材料は安全側のプレースホルダになる。
      expect(body).toContain('(該当なし)');
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
      expect(p.reason).toMatch(/already submitted today/);
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
  });

  describe('shipped registry file', () => {
    test('scripts/ai/kaggle_targets_registry.json parses and is default-OFF with 6 competitions', () => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const p = path.join(here, '..', '..', 'scripts', 'ai', 'kaggle_targets_registry.json');
      const r = parseTargetsRegistry(JSON.parse(fs.readFileSync(p, 'utf8')));
      expect(r.enabled).toBe(false);
      expect(r.competitions).toHaveLength(6);
      expect(r.rotation).toHaveLength(6);
      // 各コンペは claude/gpt の2ターゲットを持つ。
      for (const c of r.competitions) {
        expect(c.targets.map((t) => t.lineage).sort()).toEqual(['claude', 'gpt']);
      }
    });
  });
});
