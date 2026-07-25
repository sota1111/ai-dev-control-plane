/**
 * SOT-1913 / SOT-1932 — Kaggle 改善サイクルの「起案エンジン」（pure functions, no I/O）。
 *
 * 設計（docs/ai/linear/SOT-1913.md v4）:
 *  - 6コンペ × 2系統(claude=旧fable / gpt=旧sol) = 12ターゲットのレジストリ
 *    (scripts/ai/kaggle_targets_registry.json)。
 *  - 単一スケジュール JST [0,4,8,12,16,20]。**1枠=1コンペ**（rotation 表で枠→コンペを解決）。
 *  - 各枠では「その枠の当番コンペ」の claude/gpt 2ターゲットだけを対象にガード(§5)を評価し、
 *    通過分に「改善方針の親Issue」を1本 起案する。cron は LLM を呼ばず、ここは決定的処理のみ。
 *
 * ここは純粋関数（Kaggle CLI / Linear / ファイル I/O は cron 子Issue SOT-1933/1934 側）。
 * 材料（前回提出結果・完了Issueダイジェスト・failure/KPI 抜粋）とガードの各シグナルは
 * 呼び出し側が収集して渡す。engine は「どのターゲットを起案するか + 起案本文」を決める。
 */

/** 系統。claude = 旧 fable、gpt = 旧 sol(Codex)。 */
export type Lineage = 'claude' | 'gpt';

/** どうやって実際に提出するか（実提出は SOT-1934 側）。 */
export interface TargetSubmitSpec {
  /** 提出物のパス（未設定なら実提出は skip+通知で安全側）。 */
  file?: string;
  /** 提出メッセージ。 */
  message?: string;
}

/** レジストリの1ターゲット（= 1リポジトリ）。 */
export interface ImprovementTarget {
  lineage: Lineage;
  repo: string;
  /** 起案先の Linear プロジェクト名。 */
  project: string;
  /** 起案Issue先頭に載せる workers ディレクティブ（例 `solo=claude:opus, handoff=off`）。 */
  workersDirective: string;
  submit?: TargetSubmitSpec;
  /** 次に起案する改善サイクル番号（第N次）。 */
  nextCycle: number;
}

/** レジストリの1コンペ（claude/gpt の2ターゲットを持つ）。 */
export interface ImprovementCompetition {
  key: string;
  kaggleCompetition: string;
  dailySubmissionCap: number;
  targets: ImprovementTarget[];
}

/** 枠→コンペ ローテーションの1エントリ。 */
export interface RotationEntry {
  hourJst: number;
  competition: string;
}

/** kaggle_targets_registry.json をパースした形。 */
export interface TargetsRegistry {
  /** レジストリ側 kill switch（env とは AND）。 */
  enabled: boolean;
  scheduleHoursJst: number[];
  rotation: RotationEntry[];
  issueCapGuard: number;
  competitions: ImprovementCompetition[];
}

const VALID_HOUR = (h: unknown): h is number =>
  typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23;

/**
 * kaggle_targets_registry.json の生 JSON を検証済みの TargetsRegistry にする。
 * `__` で始まるキー（ドキュメント）は無視する。不正な形は Error を投げる（fail-loud）。
 */
export function parseTargetsRegistry(raw: unknown): TargetsRegistry {
  if (!raw || typeof raw !== 'object') {
    throw new Error('targets registry must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const enabled = obj.enabled;
  if (typeof enabled !== 'boolean') {
    throw new Error('registry.enabled must be a boolean');
  }

  const hoursRaw = obj.schedule_hours_jst ?? obj.scheduleHoursJst ?? [0, 4, 8, 12, 16, 20];
  if (!Array.isArray(hoursRaw) || hoursRaw.length === 0 || !hoursRaw.every(VALID_HOUR)) {
    throw new Error('registry.schedule_hours_jst must be a non-empty array of hours (0-23)');
  }
  const scheduleHoursJst = Array.from(new Set(hoursRaw as number[])).sort((a, b) => a - b);

  const rotationRaw = obj.rotation;
  if (!Array.isArray(rotationRaw) || rotationRaw.length === 0) {
    throw new Error('registry.rotation must be a non-empty array');
  }
  const rotSeen = new Set<number>();
  const rotation: RotationEntry[] = rotationRaw.map((r, i) => {
    if (!r || typeof r !== 'object') {
      throw new Error(`registry.rotation[${i}] must be an object`);
    }
    const ro = r as Record<string, unknown>;
    const hourJst = ro.hour_jst ?? ro.hourJst;
    if (!VALID_HOUR(hourJst)) {
      throw new Error(`registry.rotation[${i}].hour_jst must be an hour (0-23)`);
    }
    if (rotSeen.has(hourJst)) {
      throw new Error(`registry.rotation[${i}].hour_jst ${hourJst} is duplicated`);
    }
    rotSeen.add(hourJst);
    const competition = ro.competition;
    if (typeof competition !== 'string' || !competition) {
      throw new Error(`registry.rotation[${i}].competition must be a non-empty string`);
    }
    return { hourJst, competition };
  });

  const capGuardRaw = obj.issue_cap_guard ?? obj.issueCapGuard ?? 240;
  if (typeof capGuardRaw !== 'number' || !Number.isInteger(capGuardRaw) || capGuardRaw <= 0) {
    throw new Error('registry.issue_cap_guard must be a positive integer');
  }

  const compsRaw = obj.competitions;
  if (!Array.isArray(compsRaw) || compsRaw.length === 0) {
    throw new Error('registry.competitions must be a non-empty array');
  }
  const compSeen = new Set<string>();
  const competitions: ImprovementCompetition[] = compsRaw.map((c, i) =>
    parseCompetition(c, i, compSeen)
  );

  // rotation が参照するコンペは必ず competitions に存在すること。
  const compKeys = new Set(competitions.map((c) => c.key));
  for (const rot of rotation) {
    if (!compKeys.has(rot.competition)) {
      throw new Error(
        `registry.rotation references unknown competition "${rot.competition}"`
      );
    }
  }

  return { enabled, scheduleHoursJst, rotation, issueCapGuard: capGuardRaw, competitions };
}

function parseCompetition(
  c: unknown,
  i: number,
  seen: Set<string>
): ImprovementCompetition {
  if (!c || typeof c !== 'object') {
    throw new Error(`registry.competitions[${i}] must be an object`);
  }
  const co = c as Record<string, unknown>;
  const key = co.key;
  if (typeof key !== 'string' || !key) {
    throw new Error(`registry.competitions[${i}].key must be a non-empty string`);
  }
  if (seen.has(key)) {
    throw new Error(`registry.competitions[${i}].key "${key}" is duplicated`);
  }
  seen.add(key);

  const kaggleCompetition = co.kaggle_competition ?? co.kaggleCompetition;
  if (typeof kaggleCompetition !== 'string' || !kaggleCompetition) {
    throw new Error(`registry.competitions[${i}].kaggle_competition must be a non-empty string`);
  }

  const cap = co.daily_submission_cap ?? co.dailySubmissionCap ?? 1;
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap <= 0) {
    throw new Error(`registry.competitions[${i}].daily_submission_cap must be a positive integer`);
  }

  const targetsRaw = co.targets;
  if (!Array.isArray(targetsRaw) || targetsRaw.length === 0) {
    throw new Error(`registry.competitions[${i}].targets must be a non-empty array`);
  }
  const linSeen = new Set<string>();
  const targets: ImprovementTarget[] = targetsRaw.map((t, j) =>
    parseTarget(t, i, j, linSeen)
  );

  return { key, kaggleCompetition, dailySubmissionCap: cap, targets };
}

function parseTarget(
  t: unknown,
  ci: number,
  ti: number,
  linSeen: Set<string>
): ImprovementTarget {
  if (!t || typeof t !== 'object') {
    throw new Error(`registry.competitions[${ci}].targets[${ti}] must be an object`);
  }
  const to = t as Record<string, unknown>;
  const lineage = to.lineage;
  if (lineage !== 'claude' && lineage !== 'gpt') {
    throw new Error(
      `registry.competitions[${ci}].targets[${ti}].lineage must be "claude" or "gpt"`
    );
  }
  if (linSeen.has(lineage)) {
    throw new Error(
      `registry.competitions[${ci}].targets[${ti}].lineage "${lineage}" is duplicated in the competition`
    );
  }
  linSeen.add(lineage);
  const repo = to.repo;
  if (typeof repo !== 'string' || !repo) {
    throw new Error(`registry.competitions[${ci}].targets[${ti}].repo must be a non-empty string`);
  }
  const project = to.project;
  if (typeof project !== 'string' || !project) {
    throw new Error(`registry.competitions[${ci}].targets[${ti}].project must be a non-empty string`);
  }
  const workersDirective = to.workers_directive ?? to.workersDirective;
  if (typeof workersDirective !== 'string' || !workersDirective) {
    throw new Error(
      `registry.competitions[${ci}].targets[${ti}].workers_directive must be a non-empty string`
    );
  }
  const nextCycleRaw = to.next_cycle ?? to.nextCycle ?? 1;
  if (typeof nextCycleRaw !== 'number' || !Number.isInteger(nextCycleRaw) || nextCycleRaw <= 0) {
    throw new Error(
      `registry.competitions[${ci}].targets[${ti}].next_cycle must be a positive integer`
    );
  }
  const target: ImprovementTarget = {
    lineage,
    repo,
    project,
    workersDirective,
    nextCycle: nextCycleRaw,
  };
  if (to.submit && typeof to.submit === 'object') {
    const so = to.submit as Record<string, unknown>;
    const spec: TargetSubmitSpec = {};
    if (typeof so.file === 'string') spec.file = so.file;
    if (typeof so.message === 'string') spec.message = so.message;
    target.submit = spec;
  }
  return target;
}

/** 指定 hour(JST) が起案スケジュールの枠かどうか。 */
export function isScheduledHour(registry: TargetsRegistry, hourJst: number): boolean {
  return registry.scheduleHoursJst.includes(hourJst);
}

/** rotation 表から、その枠(hourJst)の当番コンペ key を返す（枠外なら null）。 */
export function resolveCompetitionForHour(
  registry: TargetsRegistry,
  hourJst: number
): string | null {
  const entry = registry.rotation.find((r) => r.hourJst === hourJst);
  return entry ? entry.competition : null;
}

/** コンペ key から定義を引く。 */
export function getCompetition(
  registry: TargetsRegistry,
  key: string
): ImprovementCompetition | undefined {
  return registry.competitions.find((c) => c.key === key);
}

/** cron が収集して渡す1プロジェクトぶんの起案材料（要約なしの生 digest）。 */
export interface ImprovementMaterial {
  /** 前回提出の順位/スコア（Kaggle CLI・best-effort）。「翌日に前回結果を確認」の実体。 */
  previousSubmission?: string;
  /** 直近の Done/In Review Issue ダイジェスト。 */
  recentIssuesDigest?: string;
  /** failure-log / KPI 抜粋。 */
  failureKpiExcerpt?: string;
}

/** ガードの各シグナル（cron が Linear/cooldown を見て渡す）。 */
export interface GuardSignals {
  /** 前サイクル未完了ガード: 対象プロジェクトに未終端の auto-improve 親 Issue が残っているか。 */
  hasUnfinishedCycle: boolean;
  /** 新材料ガード: 前回サイクル以降にそのプロジェクトで新しい完了 Issue があるか。 */
  hasNewMaterial: boolean;
}

/** planImprovementCycle の入力。 */
export interface CycleInput {
  registry: TargetsRegistry;
  /** 現在の JST hour（cron 起動時刻）。 */
  hourJst: number;
  /** env KAGGLE_IMPROVE_ENABLED（registry.enabled と AND）。 */
  envEnabled: boolean;
  /** workspace の総 Issue 数（Issue cap ガード用）。 */
  issueCount: number;
  /** worker usage-limit cooldown 中か（cooldown ガード用）。 */
  cooldownActive: boolean;
  /** project 名 → その project のガードシグナル。無ければ安全側（未完了なし・新材料なし）。 */
  signals?: Record<string, GuardSignals>;
  /** project 名 → 起案材料。 */
  material?: Record<string, ImprovementMaterial>;
}

/** 1ターゲットの起案結果。 */
export interface TargetPlan {
  lineage: Lineage;
  repo: string;
  project: string;
  workersDirective: string;
  competition: string;
  cycleNumber: number;
  /** draft = 起案する / skip = ガードで抑制。 */
  action: 'draft' | 'skip';
  reason: string;
  /** action=draft のときの起案Issueタイトル/本文。 */
  issueTitle?: string;
  issueBody?: string;
}

/** planImprovementCycle の出力（そのまま JSON 化して bash へ渡せる）。 */
export interface CyclePlan {
  /** enabled(registry) && envEnabled。false なら何もしない。 */
  active: boolean;
  hourJst: number;
  /** この枠の当番コンペ key（枠外/未定義なら null）。 */
  competition: string | null;
  targets: TargetPlan[];
  reason: string;
}

/** 起案Issueのタイトル（§6・process 名を避け feature/outcome 起点）。 */
export function buildIssueTitle(target: ImprovementTarget, cycleNumber: number): string {
  return `[${target.repo}] Kaggle順位向上サイクル第${cycleNumber}次 — 改善方針の立案と実施`;
}

/** 起案Issue本文テンプレート（§6・材料 digest を埋め込む。要約はしない）。 */
export function buildIssueBody(
  target: ImprovementTarget,
  competition: ImprovementCompetition,
  cycleNumber: number,
  material: ImprovementMaterial
): string {
  const prev = material.previousSubmission?.trim() || '(前回提出の記録なし — 初回サイクル、または取得できず)';
  const recent = material.recentIssuesDigest?.trim() || '(新規の完了Issueなし)';
  const failure = material.failureKpiExcerpt?.trim() || '(該当なし)';
  return `workers: ${target.workersDirective}

## 目的
Kaggleコンペ \`${competition.kaggleCompetition}\`（repo: ${target.repo} / 系統: ${target.lineage}）の
順位を向上させる次の改善方針を決定し、子Issueに分解して実施する。

## 入力材料（cronが自動収集・要約なし）
### 前回提出結果（順位/スコア）
${prev}

### 直近の完了Issueダイジェスト
${recent}

### 失敗ログ・KPI抜粋
${failure}

## 実施内容
1. 上記材料から未着手の改善軸を選定（非昇格済み軸の再試行は根拠を明示）。
2. 2〜5個の子Issueに分解して登録（子Issue記述テンプレ・screen→confirmゲート・
   非昇格時 revert+docs・昇格時 exec互換→Kaggle実証を全子に継承）。
3. 取り組み完了時点で当該コンペの現 champion を提出する。
4. 子完了後、親を In Review にして完了報告。

## 受け入れ条件
- [ ] 改善方針と選定理由がコメントに記録されている
- [ ] 子Issueが登録され、全て終端状態に達している
- [ ] 昇格/非昇格の結論が champion 状態と整合している
- [ ] 取り組み完了時に提出が行われた（提出物未整備なら skip 理由を明記）

## 関連
- 親（改善サイクル設計）: SOT-1913 / このサイクル自動起案の起点`;
}

/**
 * その枠の当番コンペの2ターゲットについて「起案するか（draft）／ガードで抑制するか（skip）」を決め、
 * draft のものは起案Issueのタイトル/本文まで生成する。cron はこの結果をそのまま Issue 作成に使う。
 *
 * ガード（§5・全て AND で通過したターゲットのみ draft）:
 *  1. active（registry.enabled && envEnabled）でなければ全 skip。
 *  2. Issue cap ガード: issueCount >= issueCapGuard なら全 skip。
 *  3. cooldown ガード: cooldownActive なら全 skip。
 *  4. 前サイクル未完了ガード: project に未終端 auto-improve 親があれば skip。
 *  5. 新材料ガード: 前回サイクル以降に新しい完了 Issue が無ければ skip。
 */
export function planImprovementCycle(input: CycleInput): CyclePlan {
  const { registry, hourJst, envEnabled, issueCount, cooldownActive } = input;
  const signals = input.signals ?? {};
  const material = input.material ?? {};
  const active = registry.enabled && envEnabled;

  const competitionKey = resolveCompetitionForHour(registry, hourJst);

  if (!active) {
    return {
      active: false,
      hourJst,
      competition: competitionKey,
      targets: [],
      reason: `disabled (registry.enabled=${registry.enabled}, envEnabled=${envEnabled})`,
    };
  }

  if (competitionKey === null) {
    return {
      active,
      hourJst,
      competition: null,
      targets: [],
      reason: `no competition scheduled for JST hour ${hourJst}`,
    };
  }

  const competition = getCompetition(registry, competitionKey);
  if (!competition) {
    return {
      active,
      hourJst,
      competition: competitionKey,
      targets: [],
      reason: `competition "${competitionKey}" not defined in registry`,
    };
  }

  // 全ターゲット共通の抑制（cap / cooldown）。
  const globalSkip =
    issueCount >= registry.issueCapGuard
      ? `issue cap guard (total ${issueCount} >= ${registry.issueCapGuard})`
      : cooldownActive
        ? 'worker cooldown active'
        : null;

  const targets: TargetPlan[] = competition.targets.map((t) => {
    const sig = signals[t.project] ?? { hasUnfinishedCycle: false, hasNewMaterial: true };
    const mat = material[t.project] ?? {};
    const common = {
      lineage: t.lineage,
      repo: t.repo,
      project: t.project,
      workersDirective: t.workersDirective,
      competition: competition.key,
      cycleNumber: t.nextCycle,
    };

    let skipReason: string | null = globalSkip;
    if (!skipReason && sig.hasUnfinishedCycle) {
      skipReason = 'previous auto-improve cycle for this project is still open';
    }
    if (!skipReason && !sig.hasNewMaterial) {
      skipReason = 'no new completed issue since the last cycle (no new material)';
    }

    if (skipReason) {
      return { ...common, action: 'skip' as const, reason: skipReason };
    }

    return {
      ...common,
      action: 'draft' as const,
      reason: 'all guards passed',
      issueTitle: buildIssueTitle(t, t.nextCycle),
      issueBody: buildIssueBody(t, competition, t.nextCycle, mat),
    };
  });

  const drafted = targets.filter((t) => t.action === 'draft').length;
  return {
    active,
    hourJst,
    competition: competition.key,
    targets,
    reason: `competition "${competition.key}": ${drafted}/${targets.length} target(s) to draft`,
  };
}
