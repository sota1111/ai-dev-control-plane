/**
 * SOT-1913 / SOT-1932 — Kaggle 改善サイクルの「起案エンジン」（pure functions, no I/O）。
 *
 * 設計（docs/ai/linear/SOT-1913.md v4）:
 *  - 7コンペ × 2系統(claude=旧fable / gpt=旧sol) = 14ターゲットのレジストリ
 *    (scripts/ai/kaggle_targets_registry.json)。
 *  - 単一スケジュールを registry で定義。**1枠=1コンペ**（rotation 表で枠→コンペを解決）。
 *  - 各枠では「その枠の当番コンペ」の claude/gpt 2ターゲットだけを対象にガード(§5)を評価し、
 *    通過分に「改善方針の親Issue」を1本 起案する。cron は LLM を呼ばず、ここは決定的処理のみ。
 *
 * ここは純粋関数（Kaggle CLI / Linear / ファイル I/O は cron 子Issue SOT-1933/1934 側）。
 * 材料（前回提出結果・完了Issueダイジェスト・failure/KPI 抜粋）とガードの各シグナルは
 * 呼び出し側が収集して渡す。engine は「どのターゲットを起案するか + 起案本文」を決める。
 */

/** 系統。claude = 旧 fable、gpt = 旧 sol(Codex)。 */
export type Lineage = 'claude' | 'gpt';

/**
 * コンペの提出モード（SOT-1913 提出cap補正）。
 *  - `both`     : claude/gpt を両方その日に提出（提出上限が2系統ぶんを許す＝cap≥2、例 ptcg/他=5/day）。
 *  - `alternate`: 1日1提出のみ許すコンペ（ARC=1/day 共有）。claude/gpt を日替わりで交互に提出する。
 */
export type SubmissionMode = 'both' | 'alternate';

/** alternate モードで「次に提出する系統」を決める（前回提出系統の逆。未提出なら claude 始まり）。 */
export function nextAlternateLineage(lastSubmitted?: Lineage | null): Lineage {
  return lastSubmitted === 'claude' ? 'gpt' : 'claude';
}

/** UTC calendar date and a registry anchor determine the lineage scheduled for that date. */
export function alternateLineageForUtcDate(
  dateUtc: string,
  anchorDateUtc: string,
  anchorLineage: Lineage
): Lineage {
  const parseDay = (value: string): number => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`alternate date must be YYYY-MM-DD: "${value}"`);
    }
    const millis = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value) {
      throw new Error(`alternate date is invalid: "${value}"`);
    }
    return Math.floor(millis / 86_400_000);
  };
  const days = Math.abs(parseDay(dateUtc) - parseDay(anchorDateUtc));
  return days % 2 === 0 ? anchorLineage : nextAlternateLineage(anchorLineage);
}

/** どうやって実際に提出するか（実提出は SOT-1934 側）。 */
export interface TargetSubmitSpec {
  /** 提出物のパス（未設定なら実提出は skip+通知で安全側）。 */
  file?: string;
  /** 提出メッセージ。 */
  message?: string;
  /** 提出物の由来。candidate は champion 昇格を要求しない。既定 candidate。 */
  source?: 'candidate' | 'champion';
  /** ログ・提出メッセージに残す候補識別子。 */
  candidateId?: string;
  /** Notebook submission contract. */
  kernel?: string;
  version?: number;
  output?: string;
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
  /** `both` mode: accepted submissions allowed per lineage and UTC day. Default 1. */
  dailySubmissionsPerLineage: number;
  /** A second daily slot is usable only for an artifact not already submitted that UTC day. */
  repeatRequiresNewArtifact: boolean;
  /** 提出モード。default `both`。ARC(1/day 共有)は `alternate`（claude/gpt を日替わり交互提出）。 */
  submissionMode: SubmissionMode;
  alternateAnchorDate?: string;
  alternateAnchorLineage?: Lineage;
  abEvaluation?: {
    gameIds: string[];
    actionBudget: number;
    trialsPerGame: number;
    seed: number;
    guardrails: {
      maxTotalTokensRatio: number;
      maxApiCostRatio: number;
      maxLatencyRatio: number;
    };
  };
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
      throw new Error(`registry.rotation references unknown competition "${rot.competition}"`);
    }
  }

  return { enabled, scheduleHoursJst, rotation, issueCapGuard: capGuardRaw, competitions };
}

function parseCompetition(c: unknown, i: number, seen: Set<string>): ImprovementCompetition {
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
  const dailySubmissionsPerLineage =
    co.daily_submissions_per_lineage ?? co.dailySubmissionsPerLineage ?? 1;
  if (
    typeof dailySubmissionsPerLineage !== 'number' ||
    !Number.isInteger(dailySubmissionsPerLineage) ||
    dailySubmissionsPerLineage < 1 ||
    dailySubmissionsPerLineage > cap
  ) {
    throw new Error(
      `registry.competitions[${i}].daily_submissions_per_lineage must be an integer between 1 and daily_submission_cap`
    );
  }
  const repeatRequiresNewArtifact =
    co.repeat_requires_new_artifact ?? co.repeatRequiresNewArtifact ?? true;
  if (typeof repeatRequiresNewArtifact !== 'boolean') {
    throw new Error(`registry.competitions[${i}].repeat_requires_new_artifact must be a boolean`);
  }

  const modeRaw = co.submission_mode ?? co.submissionMode ?? 'both';
  if (modeRaw !== 'both' && modeRaw !== 'alternate') {
    throw new Error(`registry.competitions[${i}].submission_mode must be "both" or "alternate"`);
  }
  const submissionMode = modeRaw as SubmissionMode;
  const alternateAnchorDate = co.alternate_anchor_date ?? co.alternateAnchorDate;
  const alternateAnchorLineage = co.alternate_anchor_lineage ?? co.alternateAnchorLineage;
  if (submissionMode === 'alternate') {
    if (typeof alternateAnchorDate !== 'string') {
      throw new Error(
        `registry.competitions[${i}].alternate_anchor_date is required for alternate mode`
      );
    }
    alternateLineageForUtcDate(alternateAnchorDate, alternateAnchorDate, 'claude');
    if (alternateAnchorLineage !== 'claude' && alternateAnchorLineage !== 'gpt') {
      throw new Error(
        `registry.competitions[${i}].alternate_anchor_lineage must be "claude" or "gpt"`
      );
    }
  }

  const targetsRaw = co.targets;
  if (!Array.isArray(targetsRaw) || targetsRaw.length === 0) {
    throw new Error(`registry.competitions[${i}].targets must be a non-empty array`);
  }
  const linSeen = new Set<string>();
  const targets: ImprovementTarget[] = targetsRaw.map((t, j) => parseTarget(t, i, j, linSeen));

  let abEvaluation: ImprovementCompetition['abEvaluation'];
  const abRaw = co.ab_evaluation ?? co.abEvaluation;
  if (abRaw !== undefined) {
    if (!abRaw || typeof abRaw !== 'object') {
      throw new Error(`registry.competitions[${i}].ab_evaluation must be an object`);
    }
    const ab = abRaw as Record<string, unknown>;
    const games = ab.game_ids ?? ab.gameIds;
    const actionBudget = ab.action_budget ?? ab.actionBudget;
    const trialsPerGame = ab.trials_per_game ?? ab.trialsPerGame;
    const seed = ab.seed;
    const guardRaw = ab.guardrails;
    if (
      !Array.isArray(games) ||
      games.length === 0 ||
      !games.every((game) => typeof game === 'string' && game.length > 0)
    ) {
      throw new Error(
        `registry.competitions[${i}].ab_evaluation.game_ids must be non-empty strings`
      );
    }
    if (
      !Number.isInteger(actionBudget) ||
      Number(actionBudget) <= 0 ||
      !Number.isInteger(trialsPerGame) ||
      Number(trialsPerGame) <= 0 ||
      !Number.isInteger(seed)
    ) {
      throw new Error(`registry.competitions[${i}].ab_evaluation numeric fields are invalid`);
    }
    if (!guardRaw || typeof guardRaw !== 'object') {
      throw new Error(`registry.competitions[${i}].ab_evaluation.guardrails must be an object`);
    }
    const guard = guardRaw as Record<string, unknown>;
    const maxTotalTokensRatio = guard.max_total_tokens_ratio ?? guard.maxTotalTokensRatio;
    const maxApiCostRatio = guard.max_api_cost_ratio ?? guard.maxApiCostRatio;
    const maxLatencyRatio = guard.max_latency_ratio ?? guard.maxLatencyRatio;
    if (
      ![maxTotalTokensRatio, maxApiCostRatio, maxLatencyRatio].every(
        (value) => typeof value === 'number' && Number.isFinite(value) && value > 0
      )
    ) {
      throw new Error(`registry.competitions[${i}].ab_evaluation guardrail ratios are invalid`);
    }
    abEvaluation = {
      gameIds: games as string[],
      actionBudget: actionBudget as number,
      trialsPerGame: trialsPerGame as number,
      seed: seed as number,
      guardrails: {
        maxTotalTokensRatio: maxTotalTokensRatio as number,
        maxApiCostRatio: maxApiCostRatio as number,
        maxLatencyRatio: maxLatencyRatio as number,
      },
    };
  }

  return {
    key,
    kaggleCompetition,
    dailySubmissionCap: cap,
    dailySubmissionsPerLineage,
    repeatRequiresNewArtifact,
    submissionMode,
    alternateAnchorDate: alternateAnchorDate as string | undefined,
    alternateAnchorLineage: alternateAnchorLineage as Lineage | undefined,
    abEvaluation,
    targets,
  };
}

function parseTarget(t: unknown, ci: number, ti: number, linSeen: Set<string>): ImprovementTarget {
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
    throw new Error(
      `registry.competitions[${ci}].targets[${ti}].project must be a non-empty string`
    );
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
    const source = so.source ?? 'candidate';
    if (source !== 'candidate' && source !== 'champion') {
      throw new Error(
        `registry.competitions[${ci}].targets[${ti}].submit.source must be "candidate" or "champion"`
      );
    }
    spec.source = source;
    const candidateId = so.candidate_id ?? so.candidateId;
    if (typeof candidateId === 'string' && candidateId.trim()) spec.candidateId = candidateId;
    if (typeof so.kernel === 'string') spec.kernel = so.kernel;
    if (typeof so.version === 'number' && Number.isInteger(so.version) && so.version > 0) {
      spec.version = so.version;
    }
    if (typeof so.output === 'string') spec.output = so.output;
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
  /** 同一方式で連続非改善が閾値に達した場合の、人間向けescalation理由。 */
  plateauReason?: string;
  /** Kaggle CLI の認証/疎通失敗で公式スコアを観測できない場合の、人間向けhealth signal。 */
  measurementFailureReason?: string;
}

/** planImprovementCycle の入力。 */
export interface CycleInput {
  registry: TargetsRegistry;
  /** 現在の JST hour（cron 起動時刻）。 */
  hourJst: number;
  /** env KAGGLE_IMPROVE_ENABLED（registry.enabled と AND）。 */
  envEnabled: boolean;
  /** project 名 → その project のガードシグナル。無ければ安全側（未完了なし・新材料あり）。 */
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
  const childWorkers = target.lineage === 'claude'
    ? 'workers: solo=claude:opus, handoff=off'
    : 'workers: solo=codex:gpt-5.6-sol, handoff=off\nreasoning: solo=low';
  const prev =
    material.previousSubmission?.trim() || '(前回提出の記録なし — 初回サイクル、または取得できず)';
  const recent = material.recentIssuesDigest?.trim() || '(新規の完了Issueなし)';
  const failure = material.failureKpiExcerpt?.trim() || '(該当なし)';
  const abEvaluation = competition.abEvaluation
    ? `

## 4条件A/B評価（固定契約）
- 条件: baseline / retained reasoningのみ / compactionのみ / 両方
- game: ${competition.abEvaluation.gameIds.join(', ')}
- action budget: ${competition.abEvaluation.actionBudget}
- 試行数: gameごとに${competition.abEvaluation.trialsPerGame}回（seed: ${competition.abEvaluation.seed}起点）
- 必須artifact KPI: score / level completion / actions / input・output・reasoning tokens / 実行時間 / API cost
- 昇格: scoreがbaselineを上回り、level completionが非劣化で、total tokens ≤ ${competition.abEvaluation.guardrails.maxTotalTokensRatio}x・API cost ≤ ${competition.abEvaluation.guardrails.maxApiCostRatio}x・latency ≤ ${competition.abEvaluation.guardrails.maxLatencyRatio}xを全て満たす候補だけ
- response chainは各game・試行・条件で新規作成し、日次・Issue間へ持ち越さない。継続情報はartifactとLinear Issueだけに保存する。
- 完了後の次回改善Issueは自動処理が冪等キー付きで登録する。人にIssue登録を依頼する完了文は出さない。`
    : '';
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
${abEvaluation}

## 実施内容
1. 上記材料から未着手の改善軸を選定（非昇格済み軸の再試行は根拠を明示）。
2. 2〜5個の実装・検証子Issueに分解して登録（子Issue記述テンプレ・screen→confirmゲート・
   非昇格時 revert+docs・昇格時 exec互換を全子に継承）。子IssueはKaggle提出を実行してはならない。
   各子Issueの本文先頭には必ず次のdirectiveを記載し、分解後の全工程を指定モデル・reasoningへ固定する。

\`\`\`
${childWorkers}
\`\`\`
3. 初回runは子Issue登録後に提出せず In Review で待機する。全子Issueが In Review/Doneへ到達すると
   webhookが \`<!-- auto-parent-resumed -->\` コメントを付けて親をTodoへ戻す。再開runでは子Issueを
   再作成せず、全子Issueの完了と検証結果を再取得・集約し、この親Issueだけが提出契約を通過した最新
   artifactを提出する。champion 昇格は必須条件にしないが、artifact fingerprintが前回提出と同一なら
   「非昇格・新artifactなし」と記録し、提出成功として扱わない。cronと子Issueは提出してはならない。
   提出は必ず control-plane の
   \`bash scripts/ai/kaggle_targets_submit.sh --competition ${competition.key} --repo ${target.repo} --execute\`
   を使用する。Kaggle CLI/APIを直接呼び出してfingerprint gateを迂回してはならない。
4. 親による集約・提出判定後、親を In Review にして完了報告。

## 実行リソース
- 改善の実装・学習・検証では GPU の使用を許可する。
- 改善方針の検討では Kaggle の公開ノートブック等を参考にしてよい。

## 受け入れ条件
- [ ] 改善方針と選定理由がコメントに記録されている
- [ ] 子Issueが登録され、全て終端状態に達している
- [ ] 提出した candidate/champion と検証結果の対応が記録されている
- [ ] 親の再開runが全子Issue完了を確認し、新artifactを提出した、または非昇格・新artifactなしを明記した
${
  competition.abEvaluation
    ? '- [ ] 固定4条件の必須KPI artifactと昇格判定が保存され、次回改善Issueが重複なく自動登録されている'
    : ''
}

## 関連
- 親（改善サイクル設計）: SOT-1913 / このサイクル自動起案の起点`;
}

/**
 * SOT-1934 — 「取り組み完了時に提出」の artifact 提出プラン（純粋関数）。
 *
 * SOT-1904 の「直近2提出収束ロジック／2枠選定ゲート」は **この経路では使わない**。提出対象は常に
 * registry の submit が指す検証済み artifact。champion 昇格は提出の前提にしない。別スケジュールの提出 cron は持たず、当番
 * コンペの取り組み完了時にこのプランで提出する。1枠=1コンペ一巡で各コンペ1日1提出が自然に成立する。
 */
export interface ChampionSubmitPlan {
  competition: string;
  kaggleCompetition: string;
  repo: string;
  lineage: Lineage;
  /** submit = 設定済みartifactを提出 / skip = 提出しない（理由付き）。 */
  action: 'submit' | 'skip';
  /** action=submit のときの提出物パス。 */
  file?: string;
  /** action=submit のときの提出メッセージ。 */
  message?: string;
  source?: 'candidate' | 'champion';
  candidateId?: string;
  kernel?: string;
  version?: number;
  output?: string;
  cap: number;
  submittedToday: number;
  reason: string;
}

/**
 * 1ターゲットの完了トリガ提出を決める。candidate/championを区別せず設定済みartifactを提出する。
 *  - 当日の系統別目標数に到達済みなら skip（同一枠の再実行は冪等）。
 *  - submit.file 未設定（提出物未整備）なら skip（呼び出し側が Discord 通知して安全側に倒す）。
 *  - コンペの daily_submission_cap に達していれば skip。
 *  - それ以外は submit（champion 昇格不要）。
 */
export function planChampionSubmission(
  competition: ImprovementCompetition,
  target: ImprovementTarget,
  submittedToday: number
): ChampionSubmitPlan {
  const cap = competition.dailySubmissionCap;
  const today =
    Number.isFinite(submittedToday) && submittedToday > 0 ? Math.floor(submittedToday) : 0;
  const base = {
    competition: competition.key,
    kaggleCompetition: competition.kaggleCompetition,
    repo: target.repo,
    lineage: target.lineage,
    cap,
    submittedToday: today,
  };
  const file = target.submit?.file?.trim() || '';
  const source = target.submit?.source ?? 'candidate';
  const candidateId = target.submit?.candidateId?.trim() || undefined;
  const label = candidateId || source;
  const message = target.submit?.message?.trim() || `auto-improve submit: ${target.repo} ${label}`;

  if (today >= cap) {
    return { ...base, action: 'skip', reason: `daily cap reached (${today}/${cap})` };
  }
  if (today >= competition.dailySubmissionsPerLineage) {
    return {
      ...base,
      action: 'skip',
      reason: `daily lineage target reached (idempotent): ${today}/${competition.dailySubmissionsPerLineage}`,
    };
  }
  if (!file) {
    return {
      ...base,
      action: 'skip',
      reason: 'no submit.file (提出物未整備) — skip + notify (safe side)',
    };
  }
  return {
    ...base,
    action: 'submit',
    file,
    message,
    source,
    candidateId,
    kernel: target.submit?.kernel,
    version: target.submit?.version,
    output: target.submit?.output,
    reason: `submit validated ${source} artifact${candidateId ? ` (${candidateId})` : ''}; champion promotion not required`,
  };
}

/** SOT-1934 — 当番コンペの全ターゲット（claude/gpt）ぶんの提出プラン。 */
export interface CompetitionSubmitPlan {
  competition: string;
  kaggleCompetition: string;
  /** そのコンペの提出モード（both=両系統提出 / alternate=日替わり交互）。 */
  mode: SubmissionMode;
  /** alternate モードで「今日の番」の系統（both のときは undefined）。 */
  chosenLineage?: Lineage;
  targets: ChampionSubmitPlan[];
}

/** planCompetitionSubmission の任意オプション。 */
export interface CompetitionSubmitOptions {
  /**
   * alternate モードで前回このコンペを提出した系統（Kaggle 履歴の最新提出から SOT-1934 の
   * スクリプトが決める）。未指定なら claude 始まりで交互する。both モードでは無視される。
   */
  lastSubmittedLineage?: Lineage | null;
  /** UTC calendar date used by alternate mode. Defaults to the current UTC date. */
  dateUtc?: string;
  /** Repositories that already consumed this exact daily cron slot. */
  completedSlotRepos?: ReadonlySet<string>;
  /** All accepted submissions for the competition today, including manual/unregistered ones. */
  competitionSubmittedToday?: number;
  /** SHA-256 fingerprint of the artifact currently selected for each repository. */
  artifactFingerprintsByRepo?: Readonly<Record<string, string>>;
  /** Artifact fingerprints already accepted today, grouped by repository. */
  submittedArtifactFingerprintsByRepo?: Readonly<Record<string, readonly string[]>>;
}

/**
 * コンペ key（または hourJst→rotation）から、その当番コンペの claude/gpt 両ターゲットの提出プランを作る。
 * submittedByRepo は repo 名 → 当日提出数（未指定は 0）。純粋関数（Kaggle CLI は SOT-1934 のスクリプト側）。
 *
 * SOT-1913 提出cap補正:
 *  - `both`（既定・cap≥2、例 ptcg/他=5/day）: claude/gpt を両方その日に提出（従来どおり repo 別に判定）。
 *  - `alternate`（ARC=1/day 共有）: 1日1提出のみ。`lastSubmittedLineage` の逆の系統だけを提出候補にし、
 *    もう一方は skip。当日すでにそのコンペで提出済み（両 repo 合計 >= 1）なら選ばれた系統も skip（冪等）。
 */
export function planCompetitionSubmission(
  registry: TargetsRegistry,
  competitionKey: string,
  submittedByRepo: Record<string, number> = {},
  opts: CompetitionSubmitOptions = {}
): CompetitionSubmitPlan | null {
  const competition = getCompetition(registry, competitionKey);
  if (!competition) return null;

  if (competition.submissionMode === 'alternate') {
    // ARC 系: コンペ1日1提出の共有 cap。系統を日替わりで交互に選ぶ。
    const totalToday =
      opts.competitionSubmittedToday ??
      competition.targets.reduce((sum, t) => sum + (submittedByRepo[t.repo] ?? 0), 0);
    const dateUtc = opts.dateUtc ?? new Date().toISOString().slice(0, 10);
    const chosen =
      competition.alternateAnchorDate && competition.alternateAnchorLineage
        ? alternateLineageForUtcDate(
            dateUtc,
            competition.alternateAnchorDate,
            competition.alternateAnchorLineage
          )
        : nextAlternateLineage(opts.lastSubmittedLineage ?? null);
    const targets = competition.targets.map((t) => {
      if (opts.completedSlotRepos?.has(t.repo)) {
        return {
          competition: competition.key,
          kaggleCompetition: competition.kaggleCompetition,
          repo: t.repo,
          lineage: t.lineage,
          action: 'skip' as const,
          cap: competition.dailySubmissionCap,
          submittedToday: submittedByRepo[t.repo] ?? 0,
          reason: 'daily slot already completed (idempotent rerun)',
        };
      }
      if (t.lineage !== chosen) {
        const today = submittedByRepo[t.repo] ?? 0;
        return {
          competition: competition.key,
          kaggleCompetition: competition.kaggleCompetition,
          repo: t.repo,
          lineage: t.lineage,
          action: 'skip' as const,
          cap: competition.dailySubmissionCap,
          submittedToday: today > 0 ? Math.floor(today) : 0,
          reason: `alternate mode: 今日は ${chosen} の番（${t.lineage} は次回）`,
        };
      }
      // 選ばれた系統は「コンペ全体の当日提出数」で cap/冪等を判定する（共有 cap のため）。
      return planChampionSubmission(competition, t, totalToday);
    });
    return {
      competition: competition.key,
      kaggleCompetition: competition.kaggleCompetition,
      mode: 'alternate',
      chosenLineage: chosen,
      targets,
    };
  }

  return {
    competition: competition.key,
    kaggleCompetition: competition.kaggleCompetition,
    mode: 'both',
    targets: competition.targets.map((t) => {
      const submittedToday = submittedByRepo[t.repo] ?? 0;
      const currentFingerprint = opts.artifactFingerprintsByRepo?.[t.repo];
      const submittedFingerprints = opts.submittedArtifactFingerprintsByRepo?.[t.repo] ?? [];
      const repeatBlocked =
        competition.repeatRequiresNewArtifact &&
        submittedToday > 0 &&
        (!currentFingerprint ||
          submittedFingerprints.length < submittedToday ||
          submittedFingerprints.includes(currentFingerprint));
      return (opts.competitionSubmittedToday ?? 0) >= competition.dailySubmissionCap
        ? {
            competition: competition.key,
            kaggleCompetition: competition.kaggleCompetition,
            repo: t.repo,
            lineage: t.lineage,
            action: 'skip' as const,
            cap: competition.dailySubmissionCap,
            submittedToday,
            reason: `daily competition cap reached (${opts.competitionSubmittedToday}/${competition.dailySubmissionCap})`,
          }
        : opts.completedSlotRepos?.has(t.repo)
          ? {
              competition: competition.key,
              kaggleCompetition: competition.kaggleCompetition,
              repo: t.repo,
              lineage: t.lineage,
              action: 'skip' as const,
              cap: competition.dailySubmissionCap,
              submittedToday,
              reason: 'daily slot already completed (idempotent rerun)',
            }
          : repeatBlocked
            ? {
                competition: competition.key,
                kaggleCompetition: competition.kaggleCompetition,
                repo: t.repo,
                lineage: t.lineage,
                action: 'skip' as const,
                cap: competition.dailySubmissionCap,
                submittedToday,
                reason:
                  submittedFingerprints.length < submittedToday
                    ? 'repeat requires a new artifact fingerprint; prior fingerprint is unavailable'
                    : 'repeat requires a new artifact fingerprint; selected artifact was already submitted today',
              }
            : planChampionSubmission(competition, t, submittedToday);
    }),
  };
}

/**
 * その枠の当番コンペの2ターゲットについて「起案するか（draft）／ガードで抑制するか（skip）」を決め、
 * draft のものは起案Issueのタイトル/本文まで生成する。cron はこの結果をそのまま Issue 作成に使う。
 *
 * 方針（順位最優先・「基本は起案する」）: 停滞/スコア低下や新材料の有無で起案を止めない。残すガードは
 * 構造上の active/rotation と、Linear を溢れさせない重複防止だけ。
 *  1. active（registry.enabled && envEnabled）でなければ全 skip（kill switch）。
 *  2. 当番コンペが解決できなければ全 skip（rotation）。
 *  3. 前サイクル未完了ガード（唯一の抑制）: 同じ project に稼働中（Todo/In Progress）の auto-improve
 *     親があれば、そのターゲットだけ skip（重複起案を防ぐ）。
 * それ以外（Issue cap / cooldown / 新材料 / 測定不能）は skip 理由にしない。Issue cap は起案側
 * （cron の archive → 起案）で吸収し、engine では判定しない。
 */
export function planImprovementCycle(input: CycleInput): CyclePlan {
  const { registry, hourJst, envEnabled } = input;
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

    // 唯一の抑制: 同じ project に稼働中の auto-improve 親があれば重複起案しない。
    // Issue cap / cooldown / 新材料 / 測定不能では止めない（「基本は起案する」方針）。
    if (sig.hasUnfinishedCycle) {
      return {
        ...common,
        action: 'skip' as const,
        reason: 'previous auto-improve cycle for this project is still open',
      };
    }

    return {
      ...common,
      action: 'draft' as const,
      reason: sig.plateauReason
        ? `default draft policy (order-first); ${sig.plateauReason}`
        : 'default draft policy (order-first): only duplicate-prevention guard applies',
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
