import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTargetsRegistry,
  resolveCompetitionForHour,
  resolvePinnedSlotForHour,
  getCompetition,
  isScheduledHour,
  buildIssueTitle,
  buildIssueBody,
  planImprovementCycle,
  planChampionSubmission,
  planCompetitionSubmission,
  parseSubmissionPolicy,
  nextAlternateLineage,
  alternateLineageForUtcDate,
  detectOracleDrift,
  buildOracleDriftBanner,
  DEFAULT_ORACLE_DRIFT_REANCHOR_CYCLES,
  DEFAULT_ORACLE_DRIFT_ESCALATE_CYCLES,
  type TargetsRegistry,
  type CycleInput,
  type OracleDriftSignal,
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

    // SOT-2514 — validation ブロック（一次KPI / cv_report / 参照スコア）。
    test('validation defaults to fail-safe primary:"cv" when absent', () => {
      const c = reg().competitions[0];
      expect(c.validation).toEqual({ primary: 'cv' });
    });

    test('validation parses primary/cv_report_path/tail_heavy_metric/reference_public_score', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].validation = {
        primary: 'cv',
        cv_report_path: 'docs/ai/my_cv.json',
        tail_heavy_metric: 'pooled_rmse',
        reference_public_score: 7.872,
      };
      expect(parseTargetsRegistry(raw).competitions[0].validation).toEqual({
        primary: 'cv',
        cvReportPath: 'docs/ai/my_cv.json',
        tailHeavyMetric: 'pooled_rmse',
        referencePublicScore: 7.872,
      });
    });

    test('validation accepts the lb exception and camelCase keys', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].validation = { primary: 'lb', cvReportPath: 'x/cv.json' };
      const v = parseTargetsRegistry(raw).competitions[0].validation;
      expect(v.primary).toBe('lb');
      expect(v.cvReportPath).toBe('x/cv.json');
    });

    test('validation fails loud on an invalid primary or field type', () => {
      const badPrimary = JSON.parse(JSON.stringify(rawRegistry));
      badPrimary.competitions[0].validation = { primary: 'oof' };
      expect(() => parseTargetsRegistry(badPrimary)).toThrow(/validation\.primary/);

      const badRef = JSON.parse(JSON.stringify(rawRegistry));
      badRef.competitions[0].validation = { reference_public_score: 'high' };
      expect(() => parseTargetsRegistry(badRef)).toThrow(/reference_public_score/);

      const badPath = JSON.parse(JSON.stringify(rawRegistry));
      badPath.competitions[0].validation = { cv_report_path: '' };
      expect(() => parseTargetsRegistry(badPath)).toThrow(/cv_report_path/);
    });

    // SOT-2518 — validation.require_scored_submission (P8) / metric_kind (P9)。
    test('validation parses require_scored_submission and metric_kind (snake + camel)', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].validation = {
        primary: 'cv',
        require_scored_submission: true,
        metric_kind: 'attack',
      };
      raw.competitions[1].validation = { requireScoredSubmission: false, metricKind: 'relative_rating' };
      const parsed = parseTargetsRegistry(raw);
      expect(parsed.competitions[0].validation).toMatchObject({
        requireScoredSubmission: true,
        metricKind: 'attack',
      });
      expect(parsed.competitions[1].validation).toMatchObject({
        requireScoredSubmission: false,
        metricKind: 'relative_rating',
      });
      // 欠落時は両フィールドとも undefined（後方互換）。
      expect(reg().competitions[0].validation.requireScoredSubmission).toBeUndefined();
      expect(reg().competitions[0].validation.metricKind).toBeUndefined();
    });

    test('validation fails loud on a bad require_scored_submission or metric_kind', () => {
      const badBool = JSON.parse(JSON.stringify(rawRegistry));
      badBool.competitions[0].validation = { require_scored_submission: 'yes' };
      expect(() => parseTargetsRegistry(badBool)).toThrow(/require_scored_submission/);

      const badKind = JSON.parse(JSON.stringify(rawRegistry));
      badKind.competitions[0].validation = { metric_kind: 'ranking' };
      expect(() => parseTargetsRegistry(badKind)).toThrow(/metric_kind/);
    });

    // SOT-2519 — validation.broken_submission_consecutive（broken 判定の連続回数上書き）。
    test('validation parses broken_submission_consecutive (snake + camel), missing = undefined', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].validation = { primary: 'cv', broken_submission_consecutive: 5 };
      raw.competitions[1].validation = { primary: 'cv', brokenSubmissionConsecutive: 2 };
      const parsed = parseTargetsRegistry(raw);
      expect(parsed.competitions[0].validation.brokenSubmissionConsecutive).toBe(5);
      expect(parsed.competitions[1].validation.brokenSubmissionConsecutive).toBe(2);
      // 欠落時は undefined（材料側で既定3に fail-safe）。
      expect(reg().competitions[0].validation.brokenSubmissionConsecutive).toBeUndefined();
    });

    test('validation fails loud on a non-integer/<1 broken_submission_consecutive', () => {
      const badFloat = JSON.parse(JSON.stringify(rawRegistry));
      badFloat.competitions[0].validation = { broken_submission_consecutive: 2.5 };
      expect(() => parseTargetsRegistry(badFloat)).toThrow(/broken_submission_consecutive/);

      const badZero = JSON.parse(JSON.stringify(rawRegistry));
      badZero.competitions[0].validation = { broken_submission_consecutive: 0 };
      expect(() => parseTargetsRegistry(badZero)).toThrow(/broken_submission_consecutive/);
    });

    test('the live registry parses and every competition has a validation primary', () => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const raw = JSON.parse(
        fs.readFileSync(
          path.join(here, '..', '..', 'scripts', 'ai', 'kaggle_targets_registry.json'),
          'utf8'
        )
      );
      const r = parseTargetsRegistry(raw);
      expect(r.competitions.length).toBeGreaterThan(0);
      for (const comp of r.competitions) {
        expect(['cv', 'lb']).toContain(comp.validation.primary);
      }
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

  describe('pinned slots', () => {
    const pinnedRaw = () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.enabled = true;
      raw.competitions[1].pinned_hours_jst = [8, 20];
      raw.competitions[1].pinned_lineage = 'claude';
      return raw;
    };

    test('parses pinned fields (dedupe + sort)', () => {
      const raw = pinnedRaw();
      raw.competitions[1].pinned_hours_jst = [20, 8, 20];
      const c = parseTargetsRegistry(raw).competitions[1];
      expect(c.pinnedHoursJst).toEqual([8, 20]);
      expect(c.pinnedLineage).toBe('claude');
    });

    test('rejects a pinned hour missing from schedule_hours_jst', () => {
      const raw = pinnedRaw();
      raw.competitions[1].pinned_hours_jst = [5];
      expect(() => parseTargetsRegistry(raw)).toThrow(/schedule_hours_jst/);
    });

    test('rejects the same pinned hour on two competitions', () => {
      const raw = pinnedRaw();
      raw.competitions[0].pinned_hours_jst = [8];
      expect(() => parseTargetsRegistry(raw)).toThrow(/claimed by both/);
    });

    test('rejects pinned_lineage without pinned_hours_jst', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].pinned_lineage = 'claude';
      expect(() => parseTargetsRegistry(raw)).toThrow(/requires pinned_hours_jst/);
    });

    test('resolvePinnedSlotForHour returns the pinned competition and lineage', () => {
      const r = parseTargetsRegistry(pinnedRaw());
      expect(resolvePinnedSlotForHour(r, 8)).toEqual({ competition: 'arc-agi-2', lineage: 'claude' });
      expect(resolvePinnedSlotForHour(r, 0)).toBeNull();
    });

    test('planImprovementCycle: pinned slot wins over rotation and dynamic override', () => {
      const r = parseTargetsRegistry(pinnedRaw());
      // hour 20 は rotation 未定義かつ override=ptcg でも pinned の arc-agi-2 が当番になる。
      const plan = planImprovementCycle({
        registry: r,
        hourJst: 20,
        envEnabled: true,
        competitionKeyOverride: 'ptcg',
      });
      expect(plan.competition).toBe('arc-agi-2');
      const byLineage = Object.fromEntries(plan.targets.map((t) => [t.lineage, t]));
      expect(byLineage.claude.action).toBe('draft');
      expect(byLineage.gpt.action).toBe('skip');
      expect(byLineage.gpt.reason).toMatch(/pinned slot: claude lineage only/);
    });

    test('planImprovementCycle: non-pinned hours are unaffected', () => {
      const r = parseTargetsRegistry(pinnedRaw());
      const plan = planImprovementCycle({ registry: r, hourJst: 0, envEnabled: true });
      expect(plan.competition).toBe('ptcg');
      expect(plan.targets.every((t) => t.action === 'draft')).toBe(true);
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
      expect(body).toContain('必ず web 検索を行い');
      expect(body).toContain('Kaggle の上位ノートブック');
      // 過去の入賞解法だけでなく、該当コンペ自身の Code タブの公開ノートブック（baseline/EDA/高評価）も参照する。
      expect(body).toContain('該当コンペ自身の Code タブ');
      expect(body).toContain('入賞に限らない');
      expect(body).toContain('子IssueはKaggle提出を実行してはならない');
      expect(body).toContain('auto-parent-resumed');
      // 提出は改善ゲート＋日次枠効率化ポリシーに従う（旧「新artifactなら毎回提出」から反転）。
      expect(body).toContain('提出・昇格ポリシー');
      // 未指定の材料は安全側のプレースホルダになる。
      expect(body).toContain('(該当なし)');
    });

    // SOT-2513 — KPI 階層を leak-free CV 一次へ再定義。
    test('KPI hierarchy is leak-free-CV-first; no "primary KPI = LB rank" phrasing remains', () => {
      const c = reg().competitions[0];
      const body = buildIssueBody(c.targets[0], c, 3, {
        cvSummary: 'CV RMSE 8.31 (entity holdout)',
        leaderboardSummary: 'public rank 42 / 6.40',
      });
      // 「一次KPI=LB順位」の文言が残らない（旧ヘッダ / 順位=一次KPI 系）。
      expect(body).not.toContain('Leaderboard 順位（一次KPI）');
      expect(body).not.toContain('順位が一次KPI');
      expect(body).not.toMatch(/一次KPI\s*=\s*LB順位/);
      // 一次=CV / 二次=public sanity。
      expect(body).toContain('検証階層（一次=leak-free CV / 二次=public LB）');
      expect(body).toContain('一次KPI = **leak-free CV**');
      expect(body).toContain('public 追い（public best 選抜）禁止');
      expect(body).toContain('悲観側(CV)を信じる');
      expect(body).toContain('CV RMSE 8.31 (entity holdout)');
      expect(body).toContain('public rank 42 / 6.40');
      // playbook 提出前チェックリスト参照。
      expect(body).toContain('docs/kaggle-playbook/README.md');
      expect(body).toContain('提出前チェックリスト');
      // escalation ladder 6段（新規2段 + port 過学習疑い）。
      expect(body).toContain('汎化ギャップ診断');
      expect(body).toContain('問題定式化の見直し');
      expect(body).toContain('playbook 03参照');
      expect(body).toContain('portが参照publicを上回ったら過学習疑い');
    });

    test('cvSummary missing renders the fail-safe; present renders the value', () => {
      const c = reg().competitions[0];
      const failsafe = buildIssueBody(c.targets[0], c, 3, {});
      expect(failsafe).toContain('CV未整備 — 最初の子Issue');
      const provided = buildIssueBody(c.targets[0], c, 3, { cvSummary: 'CV AUC 0.912' });
      expect(provided).toContain('CV AUC 0.912');
      expect(provided).not.toContain('CV未整備 — 最初の子Issue');
    });

    test('CV↔public gap frame is always present; ⚠ warning only when the gap exceeds threshold', () => {
      const c = reg().competitions[0];
      const noGap = buildIssueBody(c.targets[0], c, 3, {});
      expect(noGap).toContain('CV↔public gap（乖離監視）');
      expect(noGap).not.toContain('⚠ 乖離警告');
      // 大きな gap を供給すると警告が挿入される（実供給は次Issue、ここはインターフェース確認）。
      const warned = buildIssueBody(c.targets[0], c, 3, {
        cvPublicGap: 3,
        cvPublicGapWarnThreshold: 1,
      });
      expect(warned).toContain('⚠ 乖離警告');
      // 閾値未満の gap は警告を出さない。
      const small = buildIssueBody(c.targets[0], c, 3, {
        cvPublicGap: 0.2,
        cvPublicGapWarnThreshold: 1,
      });
      expect(small).not.toContain('⚠ 乖離警告');
    });

    // SOT-2514 — 参照実装スコア超過(P5)の過学習疑い警告 / gap 推移 digest を本文へ挿入する。
    test('reference-overfit warning and gap-trend digest are injected into the gap section', () => {
      const c = reg().competitions[0];
      const none = buildIssueBody(c.targets[0], c, 3, {});
      expect(none).not.toContain('過学習疑い(playbook P5)');
      const withWarn = buildIssueBody(c.targets[0], c, 3, {
        referenceOverfitWarning:
          '⚠ 過学習疑い(playbook P5): 自 best public 6.477 が参照 public 7.872 を 17.7% 上回っている。',
        cvPublicGapTrend: 'gap 推移(相対): 5.0% → 12.0% — ⚠ 乖離が拡大傾向。汎化リスク増大',
      });
      expect(withWarn).toContain('過学習疑い(playbook P5)');
      expect(withWarn).toContain('参照 public 7.872');
      expect(withWarn).toContain('gap 推移(相対)');
      expect(withWarn).toContain('汎化リスク増大');
      // 乖離監視セクション内に入っていること。
      const section = withWarn.split('### CV↔public gap（乖離監視）')[1] ?? '';
      expect(section).toContain('過学習疑い(playbook P5)');
      expect(section).toContain('gap 推移(相対)');
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

    test('agent-security embeds the permanent authorization and SDK resume gate', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].key = 'agent-security';
      raw.competitions[0].kaggle_competition = 'ai-agent-security-multi-step-tool-attacks';
      raw.rotation[0].competition = 'agent-security';
      const competition = parseTargetsRegistry(raw).competitions[0];
      const body = buildIssueBody(competition.targets[0], competition, 3, {});
      expect(body).toContain('Agent Security再開ゲート（恒久契約）');
      expect(body).toContain('agent_security_preflight.sh <repo-path>');
      expect(body).toContain('import aicomp_sdk');
      expect(body).toContain('新しい攻撃手順、認可回避');
      expect(body).toContain('ID・SHA・評価条件が固定済み');
    });

    // SOT-2516 — 収束モードの最終提出選抜分散を契約化する。
    test('converge mode encodes CV-best×hedge diversification and forbids both-public-best', () => {
      const c = reg().competitions[0];
      const body = buildIssueBody(c.targets[0], c, 3, {}, { phase: 'converge', daysToDeadline: 3 });
      expect(body).toContain('収束モード');
      // 最終2枠 = CV最良 × hedge の分散。
      expect(body).toContain('最終2枠の分散契約（CV最良×hedge）');
      // both-public-best 禁止（rogii 全滅パターン）。
      expect(body).toContain('両方を public 最良で選抜することは禁止');
      // drop-dead 運用（締切2.5h前 無条件提出）。
      expect(body).toContain('drop-dead');
      expect(body).toContain('締切2.5時間前');
      // ノイズ幅追い禁止。
      expect(body).toContain('ノイズ幅追い禁止');
      // final-selection report 契約（承認待ちでブロックしない）。
      expect(body).toContain('final-selection report 契約');
      expect(body).toContain('CV最良=X / public最良=Y / gap=Z');
      expect(body).toContain('承認待ちでブロックはしない');
      // 締切間際は Web 手動選抜の依頼コメントを残す。
      expect(body).toContain('Web で手動最終選抜を依頼');
    });

    test('explore-phase body carries no converge selection contract', () => {
      const c = reg().competitions[0];
      const body = buildIssueBody(c.targets[0], c, 3, {}, { phase: 'explore', daysToDeadline: 30 });
      expect(body).not.toContain('最終2枠の分散契約（CV最良×hedge）');
      expect(body).not.toContain('drop-dead');
    });

    // SOT-2516 — 人間コメント尊重契約（3点での最新コメント再取得 + 軽量 directive）。
    test('human-comment-respect contract: refetch at 3 decision points + lightweight directives', () => {
      const c = reg().competitions[0];
      const body = buildIssueBody(c.targets[0], c, 3, {});
      expect(body).toContain('人間コメント尊重契約');
      expect(body).toContain('newest-wins');
      // 3つの意思決定ポイント。
      expect(body).toContain('改善軸を選定する時');
      expect(body).toContain('親の再開run');
      expect(body).toContain('提出直前');
      // 軽量 directive の説明（先頭行のみ・長文埋込は検出しない）。
      expect(body).toContain('cycle=pause');
      expect(body).toContain('submit=hold');
      expect(body).toContain('コメントの先頭行');
      expect(body).toContain('埋め込みは検出しない');
      // ブロッキング承認ゲートは無い（自動性維持）。
      expect(body).toContain('人間の承認待ちでブロックはしない');
    });

    // SOT-2518 P8 — submit-repair モード。
    const repairComp = () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].validation = { primary: 'cv', require_scored_submission: true };
      return parseTargetsRegistry(raw).competitions[0];
    };

    test('broken submissions + require_scored_submission switches to submit-repair mode', () => {
      const c = repairComp();
      const body = buildIssueBody(c.targets[0], c, 3, {
        submissionHealth: 'broken',
        submissionHealthReason: '直近 3 回連続で有効スコア無し（ERROR/0.000/未スコア）',
        previousSubmission: '- 2026-08-08 status=ERROR',
      });
      expect(body).toContain('submit-repair モード');
      expect(body).toContain('新規の改善軸は起案しない');
      expect(body).toContain('有効な（非ゼロ・スコア確定）提出を1本');
      expect(body).toContain('直近 3 回連続で有効スコア無し');
      expect(body).toContain('kaggle_targets_submit.sh');
      // SOT-2519: 材料先頭の 🔴 マーカー（連続回数不明時は総称文言）。
      expect(body).toContain('🔴 提出が壊れています');
      // repair mode drops normal axis-selection framing.
      expect(body).not.toContain('検証階層（一次=leak-free CV / 二次=public LB）');
      // child directive is still pinned to the lineage model.
      expect(body).toContain('workers: solo=claude:opus, handoff=off');
    });

    test('submit-repair header shows the concrete broken run count when known (SOT-2519)', () => {
      const c = repairComp();
      const body = buildIssueBody(c.targets[0], c, 3, {
        submissionHealth: 'broken',
        submissionHealthReason: '直近 4 回連続で有効スコア無し（ERROR/0.000/未スコア）',
        submissionHealthConsecutive: 4,
      });
      expect(body).toContain('🔴 提出が壊れています（直近4回 ERROR/0.000/未掲載）');
    });

    test('broken submissions do NOT switch modes unless require_scored_submission is set', () => {
      const c = reg().competitions[0]; // no validation.require_scored_submission
      const body = buildIssueBody(c.targets[0], c, 3, {
        submissionHealth: 'broken',
        submissionHealthReason: 'x',
      });
      expect(body).not.toContain('submit-repair モード');
      expect(body).toContain('検証階層（一次=leak-free CV / 二次=public LB）');
    });

    test('ok/unknown submissionHealth keeps the normal body even when gated', () => {
      const c = repairComp();
      const ok = buildIssueBody(c.targets[0], c, 3, { submissionHealth: 'ok' });
      expect(ok).not.toContain('submit-repair モード');
      expect(ok).toContain('検証階層（一次=leak-free CV / 二次=public LB）');
    });

    // SOT-2518 P9 — relative_rating の順位契約（維持=後退）。
    test('relative_rating competitions inject the rank contract (maintain = regress)', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].validation = { primary: 'cv', metric_kind: 'relative_rating' };
      const c = parseTargetsRegistry(raw).competitions[0];
      const body = buildIssueBody(c.targets[0], c, 3, {
        rankTrend: '順位トレンド(直近3観測): 42位 → 55位 → 70位 — ⚠ 低下傾向（相対競技では維持=後退を疑え）',
      });
      expect(body).toContain('相対競技の順位契約（維持=後退');
      expect(body).toContain('維持を昇格根拠にしない');
      expect(body).toContain('前進軸');
      expect(body).toContain('実LB順位の非劣化を昇格の必須条件');
      // rankTrend material is rendered in the dedicated section (SOT-2520).
      expect(body).toContain('### 実LB順位トレンド');
      expect(body).toContain('⚠ 低下傾向');
    });

    // SOT-2520 — declining-gated maintain=regress warning.
    test('relative_rating + declining rank inserts the SOT-2520 maintain=regress warning', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].validation = { primary: 'cv', metric_kind: 'relative_rating' };
      const c = parseTargetsRegistry(raw).competitions[0];
      const body = buildIssueBody(c.targets[0], c, 3, {
        rankTrend: '順位トレンド(直近3観測): 42位 → 55位 → 70位 — ⚠ 低下傾向',
        rankTrendDirection: 'declining',
      });
      expect(body).toContain('⚠ 相対rating comp: champion維持は field改善下で後退');
      expect(body).toContain('maintain を昇格根拠にせず');
      expect(body).toContain('opponent field に上位公開解法を取り込み評価fieldを更新せよ');
    });

    test('relative_rating without declining trend keeps the general contract but omits the warning', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].validation = { primary: 'cv', metric_kind: 'relative_rating' };
      const c = parseTargetsRegistry(raw).competitions[0];
      for (const dir of ['improving', 'flat', 'new', undefined] as const) {
        const body = buildIssueBody(c.targets[0], c, 3, {
          rankTrend: '順位トレンド(直近2観測): 70位 → 42位 — 上昇傾向',
          ...(dir ? { rankTrendDirection: dir } : {}),
        });
        // general relative contract stays…
        expect(body).toContain('相対競技の順位契約（維持=後退');
        // …but the declining-gated warning must not fire.
        expect(body).not.toContain('⚠ 相対rating comp: champion維持は field改善下で後退');
      }
    });

    test('regression (non-relative) competitions get no rank contract nor warning', () => {
      const c = reg().competitions[0]; // no metric_kind → regression default
      const body = buildIssueBody(c.targets[0], c, 3, {
        rankTrend: '順位トレンド(直近2観測): 40位 → 42位 — ⚠ 低下傾向',
        rankTrendDirection: 'declining',
      });
      expect(body).not.toContain('相対競技の順位契約');
      expect(body).not.toContain('⚠ 相対rating comp: champion維持は field改善下で後退');
      // the neutral rank-trend material is still shown in its dedicated section.
      expect(body).toContain('### 実LB順位トレンド');
      expect(body).toContain('順位トレンド');
    });

    // P10 — oracle-drift（proxy飽和×真KPI停滞→再アンカー強制）。SIGNATE rank-26 post-mortem。
    test('oracle-drift banner is injected when proxy saturated AND true KPI stagnant', () => {
      const c = reg().competitions[0];
      const body = buildIssueBody(c.targets[0], c, 3, {
        oracleDrift: {
          proxyKpiName: 'gold100 net',
          proxySaturated: true,
          trueKpiName: 'private accuracy',
          trueKpiStagnant: true,
          stagnantCycles: 2,
          detail: 'net 96→99 と登ったが真値精度は88.5%で停滞',
        },
      });
      expect(body).toContain('🔻 ORACLE DRIFT 検知');
      expect(body).toContain('局所A/B・per-idx回収を新規に起案してはならない');
      expect(body).toContain('escalation ladder (2) データ/oracle 再アンカー');
      expect(body).toContain('gold100 net');
      expect(body).toContain('private accuracy');
      expect(body).toContain('net 96→99 と登ったが真値精度は88.5%で停滞');
      // reanchor level does NOT demand human escalation.
      expect(body).not.toContain('⚠ ORACLE-DRIFT ESCALATION');
      // normal material framing is retained (banner prepends, does not replace).
      expect(body).toContain('検証階層（一次=leak-free CV / 二次=public LB）');
    });

    test('oracle-drift escalation banner at the higher threshold demands human escalation', () => {
      const c = reg().competitions[0];
      const body = buildIssueBody(c.targets[0], c, 3, {
        oracleDrift: {
          proxySaturated: true,
          trueKpiStagnant: true,
          stagnantCycles: DEFAULT_ORACLE_DRIFT_ESCALATE_CYCLES,
        },
      });
      expect(body).toContain('🔻🔻 ORACLE DRIFT（エスカレーション）');
      expect(body).toContain('⚠ ORACLE-DRIFT ESCALATION');
      expect(body).toContain('人間へエスカレーション');
    });

    test('no oracle-drift banner unless BOTH proxy saturated and true KPI stagnant', () => {
      const c = reg().competitions[0];
      const proxyOnly = buildIssueBody(c.targets[0], c, 3, {
        oracleDrift: { proxySaturated: true, trueKpiStagnant: false, stagnantCycles: 5 },
      });
      const trueOnly = buildIssueBody(c.targets[0], c, 3, {
        oracleDrift: { proxySaturated: false, trueKpiStagnant: true, stagnantCycles: 5 },
      });
      const none = buildIssueBody(c.targets[0], c, 3, {});
      for (const body of [proxyOnly, trueOnly, none]) {
        expect(body).not.toContain('ORACLE DRIFT');
        expect(body).toContain('## 目的');
      }
    });

    // 行き詰まり時の「過去 Kaggle 上位解法を参照・移植」優先軸バナー。
    const STUCK_HEADING = '🔺 行き詰まり検知';
    const STUCK_AXIS = '過去 Kaggle 上位解法の調査と移植';

    test('stuck banner fires on declining or flat LB rank trend', () => {
      const c = reg().competitions[0];
      for (const dir of ['declining', 'flat'] as const) {
        const body = buildIssueBody(c.targets[0], c, 3, { rankTrendDirection: dir });
        expect(body).toContain(STUCK_HEADING);
        expect(body).toContain(STUCK_AXIS);
        expect(body).toContain('外部知識取り込み');
        // 該当コンペ自身の公開ノートブック（Code タブ）も第一級ソースとして指示する。
        expect(body).toContain('該当コンペ自身の公開ノートブック');
        // コンペ slug を明示して「このコンペの」上位解法へ誘導する。
        expect(body).toContain(c.kaggleCompetition);
      }
    });

    test('stuck banner fires under oracle-drift (proxy saturated AND true KPI stagnant)', () => {
      const c = reg().competitions[0];
      const body = buildIssueBody(c.targets[0], c, 3, {
        oracleDrift: { proxySaturated: true, trueKpiStagnant: true, stagnantCycles: 2 },
      });
      expect(body).toContain(STUCK_HEADING);
      expect(body).toContain(STUCK_AXIS);
    });

    test('stuck banner does NOT fire while improving / new / unknown / absent', () => {
      const c = reg().competitions[0];
      for (const dir of ['improving', 'new', 'unknown', undefined] as const) {
        const body = buildIssueBody(c.targets[0], c, 3, {
          ...(dir ? { rankTrendDirection: dir } : {}),
        });
        expect(body).not.toContain(STUCK_HEADING);
        expect(body).toContain('## 目的');
      }
    });

    test('stuck banner is suppressed in proxy-establishment stage even when stuck', () => {
      const c = reg().competitions[0];
      const proxyTarget = { ...c.targets[0], stage: 'proxy' as const };
      const body = buildIssueBody(proxyTarget, c, 3, { rankTrendDirection: 'declining' });
      expect(body).not.toContain(STUCK_HEADING);
      // proxy 確立モードのバナーは出る（目標は CV 構築で、外部解法探索より基盤整備を優先）。
      expect(body).toContain('段階目標: proxy 確立モード');
    });

    test('submit-repair takes precedence over oracle-drift (cannot measure true KPI while broken)', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].validation = { primary: 'cv', require_scored_submission: true };
      const c = parseTargetsRegistry(raw).competitions[0];
      const body = buildIssueBody(c.targets[0], c, 3, {
        submissionHealth: 'broken',
        submissionHealthReason: 'x',
        oracleDrift: { proxySaturated: true, trueKpiStagnant: true, stagnantCycles: 9 },
      });
      expect(body).toContain('submit-repair モード');
      expect(body).not.toContain('ORACLE DRIFT');
    });
  });

  // P10 — detectOracleDrift 純粋関数。
  describe('detectOracleDrift', () => {
    const drift = (over: Partial<OracleDriftSignal>): OracleDriftSignal => ({
      proxySaturated: true,
      trueKpiStagnant: true,
      stagnantCycles: DEFAULT_ORACLE_DRIFT_REANCHOR_CYCLES,
      ...over,
    });

    test('undefined signal → none (backward compatible)', () => {
      expect(detectOracleDrift(undefined)).toMatchObject({ level: 'none', drifting: false });
    });

    test('requires BOTH conditions', () => {
      expect(detectOracleDrift(drift({ proxySaturated: false })).drifting).toBe(false);
      expect(detectOracleDrift(drift({ trueKpiStagnant: false })).drifting).toBe(false);
    });

    test('reanchor at the reanchor threshold, escalate at the escalate threshold', () => {
      expect(detectOracleDrift(drift({ stagnantCycles: 1 })).level).toBe('none');
      expect(detectOracleDrift(drift({ stagnantCycles: DEFAULT_ORACLE_DRIFT_REANCHOR_CYCLES })).level).toBe(
        'reanchor'
      );
      expect(detectOracleDrift(drift({ stagnantCycles: DEFAULT_ORACLE_DRIFT_ESCALATE_CYCLES })).level).toBe(
        'escalate'
      );
    });

    test('custom thresholds are honored', () => {
      const r = detectOracleDrift(drift({ stagnantCycles: 3 }), { reanchorCycles: 5, escalateCycles: 10 });
      expect(r.level).toBe('none');
    });

    test('buildOracleDriftBanner is empty when not drifting', () => {
      const result = detectOracleDrift(drift({ trueKpiStagnant: false }));
      expect(buildOracleDriftBanner(drift({ trueKpiStagnant: false }), result)).toBe('');
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

    test('order-first policy: drafts even with no new material (guard removed)', () => {
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
      expect(claude.action).toBe('draft');
      expect(claude.reason).toMatch(/default draft policy/);
    });

    test('order-first policy: drafts even when Kaggle measurement failed (guard removed)', () => {
      const plan = planImprovementCycle(
        baseInput({
          registry: enabledReg(),
          hourJst: 0,
          signals: {
            'ptcg-agent-claude': {
              hasUnfinishedCycle: false,
              hasNewMaterial: true,
              measurementFailureReason:
                'measurement unavailable: Kaggle CLI authentication failed; verify cron credentials/API token',
            },
          },
        })
      );
      const claude = plan.targets.find((t) => t.project === 'ptcg-agent-claude')!;
      expect(claude.action).toBe('draft');
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

    test('plateau escalation triggers drafting from the scored result', () => {
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
      expect(claude.action).toBe('draft');
      expect(claude.reason).toMatch(/plateau escalation/);
    });

    test('oracle-drift annotates the draft reason and injects the banner into the body', () => {
      const plan = planImprovementCycle(
        baseInput({
          registry: enabledReg(),
          hourJst: 0,
          material: {
            'ptcg-agent-claude': {
              oracleDrift: {
                proxySaturated: true,
                trueKpiStagnant: true,
                stagnantCycles: DEFAULT_ORACLE_DRIFT_REANCHOR_CYCLES,
              },
            },
          },
        })
      );
      const claude = plan.targets.find((t) => t.project === 'ptcg-agent-claude')!;
      expect(claude.action).toBe('draft');
      expect(claude.reason).toMatch(/oracle-drift \(reanchor\)/);
      expect(claude.issueBody).toContain('🔻 ORACLE DRIFT 検知');
    });
  });

  // SOT-1934 — 完了トリガの validated artifact 提出（champion 昇格不要）。
  describe('planChampionSubmission', () => {
    const ptcg = () => getCompetition(reg(), 'ptcg')!;
    const claudeTarget = () => ptcg().targets.find((t) => t.lineage === 'claude')!; // submit.file = ''
    const gptTarget = () => {
      const t = ptcg().targets.find((t) => t.lineage === 'gpt')!;
      return { ...t, submit: { file: 'submission/main.py', message: 'm' } };
    };

    test('submits a configured artifact when a submit.file exists and none submitted today', () => {
      const p = planChampionSubmission(ptcg(), gptTarget(), 0);
      expect(p.action).toBe('submit');
      expect(p.file).toBe('submission/main.py');
      expect(p.source).toBe('candidate');
      expect(p.reason).toMatch(/champion promotion not required/);
    });

    test('submits a validated non-champion candidate with provenance', () => {
      const target = {
        ...gptTarget(),
        submit: {
          file: 'submission/candidate.py',
          message: 'candidate experiment',
          source: 'candidate' as const,
          candidateId: 'exp-42',
          kernel: 'owner/kernel',
          version: 7,
          output: 'submission.csv',
        },
      };
      const p = planChampionSubmission(ptcg(), target, 0);
      expect(p.action).toBe('submit');
      expect(p.candidateId).toBe('exp-42');
      expect(p.kernel).toBe('owner/kernel');
      expect(p.version).toBe(7);
      expect(p.output).toBe('submission.csv');
      expect(p.reason).toMatch(/validated candidate artifact/);
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

    test('both mode accepts a second daily submission when each lineage has a new artifact', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].daily_submissions_per_lineage = 2;
      raw.competitions[0].targets[0].submit = { file: 'submission/claude.py', message: 'm' };
      raw.competitions[0].targets[1].submit = { file: 'submission/gpt.py', message: 'm' };
      const registry = parseTargetsRegistry(raw);
      expect(
        planCompetitionSubmission(
          registry,
          'ptcg',
          { 'ptcg-agent-claude': 1, 'ptcg-agent-gpt': 1 },
          {
            artifactFingerprintsByRepo: {
              'ptcg-agent-claude': 'sha256:claude-new',
              'ptcg-agent-gpt': 'sha256:gpt-new',
            },
            submittedArtifactFingerprintsByRepo: {
              'ptcg-agent-claude': ['sha256:claude-old'],
              'ptcg-agent-gpt': ['sha256:gpt-old'],
            },
          }
        )!.targets.every((target) => target.action === 'submit')
      ).toBe(true);
      expect(
        planCompetitionSubmission(registry, 'ptcg', {
          'ptcg-agent-claude': 2,
          'ptcg-agent-gpt': 2,
        })!.targets.every((target) => target.action === 'skip')
      ).toBe(true);
    });

    test('same-slot rerun does not consume the next lineage allowance', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].daily_submissions_per_lineage = 2;
      raw.competitions[0].targets[0].submit = { file: 'submission/claude.py', message: 'm' };
      raw.competitions[0].targets[1].submit = { file: 'submission/gpt.py', message: 'm' };
      const registry = parseTargetsRegistry(raw);
      const plan = planCompetitionSubmission(
        registry,
        'ptcg',
        { 'ptcg-agent-claude': 1, 'ptcg-agent-gpt': 1 },
        { completedSlotRepos: new Set(['ptcg-agent-claude', 'ptcg-agent-gpt']) }
      )!;
      expect(plan.targets.every((target) => target.action === 'skip')).toBe(true);
      expect(plan.targets.every((target) => target.reason.includes('slot already completed'))).toBe(
        true
      );
    });

    test('fingerprint-gated repeats reject duplicates and accept an independently verified artifact', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].daily_submissions_per_lineage = 2;
      raw.competitions[0].repeat_requires_new_artifact = true;
      raw.competitions[0].targets[0].submit = { file: 'submission/claude.py', message: 'm' };
      const registry = parseTargetsRegistry(raw);
      const common = {
        artifactFingerprintsByRepo: { 'ptcg-agent-claude': 'sha256:same' },
        submittedArtifactFingerprintsByRepo: { 'ptcg-agent-claude': ['sha256:same'] },
      };
      expect(
        planCompetitionSubmission(registry, 'ptcg', { 'ptcg-agent-claude': 1 }, common)!.targets[0]
      ).toMatchObject({ action: 'skip' });
      expect(
        planCompetitionSubmission(
          registry,
          'ptcg',
          { 'ptcg-agent-claude': 1 },
          {
            ...common,
            artifactFingerprintsByRepo: { 'ptcg-agent-claude': 'sha256:new' },
          }
        )!.targets[0]
      ).toMatchObject({ action: 'submit' });
    });

    test('fingerprint-gated repeats fail closed when prior provenance is unavailable', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].daily_submissions_per_lineage = 2;
      raw.competitions[0].repeat_requires_new_artifact = true;
      raw.competitions[0].targets[0].submit = { file: 'submission/claude.py', message: 'm' };
      const plan = planCompetitionSubmission(
        parseTargetsRegistry(raw),
        'ptcg',
        { 'ptcg-agent-claude': 1 },
        { artifactFingerprintsByRepo: { 'ptcg-agent-claude': 'sha256:current' } }
      )!;
      expect(plan.targets[0].reason).toContain('prior fingerprint is unavailable');
    });

    test('manual submissions also consume the competition daily cap', () => {
      const raw = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].daily_submission_cap = 2;
      raw.competitions[0].daily_submissions_per_lineage = 2;
      raw.competitions[0].targets[0].submit = { file: 'submission/claude.py', message: 'm' };
      raw.competitions[0].targets[1].submit = { file: 'submission/gpt.py', message: 'm' };
      const plan = planCompetitionSubmission(
        parseTargetsRegistry(raw),
        'ptcg',
        {},
        {
          competitionSubmittedToday: 2,
        }
      )!;
      expect(plan.targets.every((target) => target.action === 'skip')).toBe(true);
      expect(plan.targets[0].reason).toContain('competition cap reached');
    });

    // 日次枠効率化: reserve — 自動ループは cap - reserve までしか消費しない。
    test('reserve holds slots: skip once competitionSubmittedToday >= cap - reserve', () => {
      const raw: any = JSON.parse(JSON.stringify(rawRegistry));
      raw.submission_policy = { daily_reserve: 1, min_interval_min: 0 };
      raw.competitions[0].daily_submission_cap = 5;
      raw.competitions[0].daily_submissions_per_lineage = 2;
      raw.competitions[0].targets[0].submit = { file: 'submission/claude.py', message: 'm' };
      raw.competitions[0].targets[1].submit = { file: 'submission/gpt.py', message: 'm' };
      const reg2 = parseTargetsRegistry(raw);
      // 4/5 submitted, reserve 1 → effective cap 4 → reserve holds (not the hard cap of 5).
      const held = planCompetitionSubmission(reg2, 'ptcg', {}, {
        competitionSubmittedToday: 4,
        submissionPolicy: reg2.submissionPolicy,
      })!;
      expect(held.targets.every((t) => t.action === 'skip')).toBe(true);
      expect(held.targets[0].reason).toContain('reserve');
      // 3/5 submitted → below effective cap → reserve does NOT hold (submits).
      const open = planCompetitionSubmission(reg2, 'ptcg', {}, {
        competitionSubmittedToday: 3,
        submissionPolicy: reg2.submissionPolicy,
      })!;
      expect(open.targets.some((t) => t.action === 'submit')).toBe(true);
    });

    // 日次枠効率化: spacing — 直近提出から min_interval_min 未満は見送り。
    test('spacing skips a repo whose last submit is within min_interval_min', () => {
      const raw: any = JSON.parse(JSON.stringify(rawRegistry));
      raw.submission_policy = { daily_reserve: 0, min_interval_min: 180 };
      raw.competitions[0].targets[0].submit = { file: 'submission/claude.py', message: 'm' };
      raw.competitions[0].targets[1].submit = { file: 'submission/gpt.py', message: 'm' };
      const reg2 = parseTargetsRegistry(raw);
      const now = 1_700_000_000_000;
      const plan = planCompetitionSubmission(reg2, 'ptcg', {}, {
        competitionSubmittedToday: 1,
        submissionPolicy: reg2.submissionPolicy,
        nowEpochMs: now,
        lastSubmitEpochMsByRepo: { 'ptcg-agent-claude': now - 60 * 60_000 }, // 60min ago < 180
      })!;
      const claude = plan.targets.find((t) => t.repo === 'ptcg-agent-claude')!;
      const gpt = plan.targets.find((t) => t.repo === 'ptcg-agent-gpt')!;
      expect(claude.action).toBe('skip');
      expect(claude.reason).toContain('spacing');
      // gpt has no recent submission → spacing does not apply.
      expect(gpt.reason).not.toContain('spacing');
      // Same repo but 200min ago → spacing satisfied (not skipped for spacing).
      const later = planCompetitionSubmission(reg2, 'ptcg', {}, {
        competitionSubmittedToday: 1,
        submissionPolicy: reg2.submissionPolicy,
        nowEpochMs: now,
        lastSubmitEpochMsByRepo: { 'ptcg-agent-claude': now - 200 * 60_000 },
      })!;
      expect(later.targets.find((t) => t.repo === 'ptcg-agent-claude')!.reason).not.toContain(
        'spacing'
      );
    });

    test('buildIssueBody: submission policy is improvement-gated + budget-aware', () => {
      const c = reg().competitions[0];
      const body = buildIssueBody(c.targets[0], c, 3, {
        submissionBudget: '- 本日(UTC 2026-08-20)の消費枠: 2/5（残 3）',
      });
      // private-anchored: 二信号一致ゲート / public=反証器 / プローブ枠。
      expect(body).toContain('提出・昇格ポリシー');
      expect(body).toContain('二信号一致ゲート');
      expect(body).toContain('反証器'); // public は目標でなく反証器
      expect(body).toContain('transfer-trust');
      expect(body).toContain('プローブ枠');
      // explore中は最終2枠の候補セット整備を子Issue化しない（converge限定）— SOT-2904 の再発防止。
      expect(body).toContain('converge フェーズでのみ行う選抜規律');
      expect(body).toContain('子Issueを作ってはならない');
      // explore(phase未指定)では収束モード「節」は描画されない（ポリシー文中の参照名とは区別）。
      expect(body).not.toContain('収束モード（締切まで残り');
      expect(body).toContain('本日の提出予算');
      expect(body).toContain('消費枠: 2/5'); // injected budget material is rendered
      // 高得点公開ノート材料が注入されていれば専用セクションに描画される。
      const withNotebooks = buildIssueBody(c.targets[0], c, 3, {
        publicNotebooksDigest: '1. `foo/bar` — 高得点ノート\n\n**参照方針**: leak-free CV',
      });
      expect(withNotebooks).toContain('高得点公開ノート（Kaggle Code');
      expect(withNotebooks).toContain('foo/bar');
      // 旧ポリシー（毎サイクル提出容認 / public追い）は撤去済み。
      expect(body).not.toContain('champion 昇格は必須条件にしない');
      // cv_representative=true（既定）は agent/RL 退避ブロックを出さない。
      expect(body).not.toContain('cv_representative=false');
    });

    test('buildIssueBody: cv_representative=false inserts the agent/RL fallback (no champion-chasing)', () => {
      const raw: any = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].cv_representative = false;
      const c = parseTargetsRegistry(raw).competitions[0];
      expect(c.cvRepresentative).toBe(false);
      const body = buildIssueBody(c.targets[0], c, 3, {});
      expect(body).toContain('cv_representative=false（agent/RL');
      expect(body).toContain('役割B'); // 評価系再設計へ退避
      expect(body).toContain('champion 化・local A/B の追い込みはしない');
    });

    test('parseSubmissionPolicy: defaults + validation (fail-safe to 0/0/0)', () => {
      expect(parseSubmissionPolicy(undefined)).toEqual({
        dailyReserve: 0,
        minIntervalMin: 0,
        probeAfterHours: 0,
      });
      expect(
        parseSubmissionPolicy({ daily_reserve: 2, min_interval_min: 90, probe_after_hours: 8 })
      ).toEqual({ dailyReserve: 2, minIntervalMin: 90, probeAfterHours: 8 });
      // 負値/非数値は 0 に倒す。
      expect(
        parseSubmissionPolicy({ daily_reserve: -1, min_interval_min: 'x', probe_after_hours: -3 })
      ).toEqual({ dailyReserve: 0, minIntervalMin: 0, probeAfterHours: 0 });
    });
  });

  describe('shipped registry file', () => {
    test('scripts/ai/kaggle_targets_registry.json is the completion-driven biohub+kaggriculture registry', () => {
      // 完了駆動ループ化（旧 JST時刻枠 rotation を撤去）: registry は biohub / kaggriculture の
      // 2コンペのみ。他コンペ（ptcg/arc-agi-2/arc-agi-3/agent-security/rogii）は削除済み。
      const here = path.dirname(fileURLToPath(import.meta.url));
      const p = path.join(here, '..', '..', 'scripts', 'ai', 'kaggle_targets_registry.json');
      const r = parseTargetsRegistry(JSON.parse(fs.readFileSync(p, 'utf8')));
      // enabled は運用 kill switch（人間/セッションが随時トグルする）— 値そのものは断言しない。
      expect(typeof r.enabled).toBe('boolean');
      // 日次枠効率化ポリシー（reserve/spacing）が設定され妥当であること。
      expect(r.submissionPolicy.dailyReserve).toBeGreaterThanOrEqual(0);
      expect(r.submissionPolicy.minIntervalMin).toBeGreaterThanOrEqual(0);
      expect(r.competitions.map((c) => c.key).sort()).toEqual(['biohub', 'kaggriculture']);
      // 削除したコンペが再混入していないこと。
      for (const gone of ['ptcg', 'arc-agi-2', 'arc-agi-3', 'agent-security', 'rogii']) {
        expect(r.competitions.some((c) => c.key === gone)).toBe(false);
      }
      // rotation/schedule_hours_jst は parse 互換のため残す vestige（起票トリガーには使わない）。
      // 参照先は必ず現存コンペであること。
      const compKeys = new Set(r.competitions.map((c) => c.key));
      for (const slot of r.rotation) {
        expect(compKeys.has(slot.competition)).toBe(true);
      }
      // 各コンペは claude/gpt の2ターゲットを持つ。
      for (const c of r.competitions) {
        expect(c.targets.map((t) => t.lineage).sort()).toEqual(['claude', 'gpt']);
      }
      expect(r.competitions.find((c) => c.key === 'kaggriculture')).toMatchObject({
        kaggleCompetition: 'kaggriculture',
        dailySubmissionCap: 5,
        dailySubmissionsPerLineage: 5,
        submissionMode: 'both',
      });
      expect(r.competitions.find((c) => c.key === 'biohub')).toMatchObject({
        dailySubmissionCap: 5,
        dailySubmissionsPerLineage: 5,
        submissionMode: 'both',
      });
      // mode:maintain 側は起票しない（biohub=gpt維持 / kaggriculture=claude維持）。improve 側だけが
      // 完了駆動ループの起票対象（biohub-claude / kaggriculture-gpt）。
      const modeOf = (compKey: string, lineage: string) =>
        r.competitions.find((c) => c.key === compKey)!.targets.find((t) => t.lineage === lineage)!.mode;
      expect(modeOf('biohub', 'gpt')).toBe('maintain');
      expect(modeOf('biohub', 'claude')).not.toBe('maintain');
      expect(modeOf('kaggriculture', 'claude')).toBe('maintain');
      expect(modeOf('kaggriculture', 'gpt')).not.toBe('maintain');
      for (const c of r.competitions) {
        const claude = c.targets.find((t) => t.lineage === 'claude')!;
        const gpt = c.targets.find((t) => t.lineage === 'gpt')!;
        expect(claude.workersDirective).toContain('solo=claude:fable');
        expect(gpt.workersDirective).toContain('solo=codex:sol');
        expect(gpt.workersDirective).toContain('reasoning: solo=ultra');
        expect(buildIssueBody(claude, c, 1, {})).toContain(
          'workers: solo=claude:opus, handoff=off'
        );
        const gptBody = buildIssueBody(gpt, c, 1, {});
        expect(gptBody).toContain('workers: solo=codex:gpt-5.6-sol, handoff=off');
        expect(gptBody).toContain('reasoning: solo=low');
      }
      // 残存2コンペは 5/day & both（旧 ARC の 1/day & alternate は削除済み）。
      for (const c of r.competitions) {
        expect(c.dailySubmissionCap).toBe(5);
        expect(c.submissionMode).toBe('both');
      }
    });
  });

  // signate Sonnetサイクル教訓の移植（#1〜#6）: stage / 申し送り / 相手系統台帳 / 証拠要件 / fingerprint。
  describe('signate-lessons: stage / handoff / counterpart / evidence contracts', () => {
    test('parseTarget: stage defaults to improve and rejects unknown values', () => {
      const t = reg().competitions[0].targets[0];
      expect(t.stage).toBe('improve');
      const raw: any = JSON.parse(JSON.stringify(rawRegistry));
      raw.competitions[0].targets[0].stage = 'bogus';
      expect(() => parseTargetsRegistry(raw)).toThrow(/stage must be/);
    });

    test('stage=submit-valid forces the submit-repair body regardless of submission health', () => {
      const c = reg().competitions[0];
      const body = buildIssueBody({ ...c.targets[0], stage: 'submit-valid' }, c, 3, {
        submissionHealth: 'ok',
      });
      expect(body).toContain('submit-repair モード');
      expect(body).toContain('新規の改善軸は起案しない');
    });

    test('stage=proxy inserts the proxy-freeze banner; default improve does not', () => {
      const c = reg().competitions[0];
      const proxy = buildIssueBody({ ...c.targets[0], stage: 'proxy' }, c, 3, {});
      expect(proxy).toContain('段階目標: proxy 確立モード');
      expect(proxy).toContain('昇格判断・champion 更新を行わない');
      const normal = buildIssueBody(c.targets[0], c, 3, {});
      expect(normal).not.toContain('段階目標: proxy 確立モード');
    });

    test('previous cycle handoff renders provided text or the fail-safe placeholder', () => {
      const c = reg().competitions[0];
      const withHandoff = buildIssueBody(c.targets[0], c, 3, {
        previousCycleHandoff: '（SOT-9999 より）次はopponent field更新を試す',
      });
      expect(withHandoff).toContain('### 前回サイクルの申し送り');
      expect(withHandoff).toContain('次はopponent field更新を試す');
      const without = buildIssueBody(c.targets[0], c, 3, {});
      expect(without).toContain('(前回サイクルの申し送りなし');
    });

    test('counterpart lineage ledger renders only when provided', () => {
      const c = reg().competitions[0];
      const withCounterpart = buildIssueBody(c.targets[0], c, 3, {
        counterpartLedgerDigest: '（gpt 系統）promoted: leaf-eval軸',
      });
      expect(withCounterpart).toContain('相手系統の実験台帳');
      expect(withCounterpart).toContain('promoted: leaf-eval軸');
      const without = buildIssueBody(c.targets[0], c, 3, {});
      expect(without).not.toContain('相手系統の実験台帳');
    });

    test('body carries evidence-for-reject, config fingerprint and handoff-comment contracts', () => {
      const c = reg().competitions[0];
      const body = buildIssueBody(c.targets[0], c, 3, {});
      expect(body).toContain('失敗帰属の証拠要件');
      expect(body).toContain('inconclusive 止まり');
      expect(body).toContain('effective-config fingerprint');
      expect(body).toContain('## 申し送り');
    });
  });
});
