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

import { parseAllocationConfig, type AllocationConfig } from './resourceAllocation.js';

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

/**
 * ターゲットの運用モード（design/README.md §49 飽和時の戦略転換）。
 *  - `improve`  : 通常の改善サイクル起案対象（既定）。
 *  - `maintain` : 全 escalation ladder を尽くして飽和した系統。新規改善Issueを起案せず、既存
 *                 champion/candidate の維持提出だけを続ける（資源を他コンペへ再配分する縮退状態）。
 */
export type TargetMode = 'improve' | 'maintain';

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
  /** 運用モード。既定 improve。 */
  mode: TargetMode;
  /**
   * 段階目標ステート（signate Sonnetサイクル教訓の移植）。省略時 `improve`（従来挙動）。
   * - `submit-valid`: 有効提出が成立するまで改善軸を凍結（submissionHealth に依らず submit-repair 本文へ固定）。
   * - `proxy`: leak-free CV/ローカルproxy の確立が唯一の目標（proxy 確立まで改善軸・昇格判断を凍結）。
   * - `improve`: 通常の改善サイクル（従来どおり）。
   */
  stage: TargetStage;
}

/** 段階目標ステート（agent-security の「全提出ERRORのまま改善サイクル空回り」再発防止）。 */
export type TargetStage = 'submit-valid' | 'proxy' | 'improve';

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
  /** コンペ締切（UTC, YYYY-MM-DD または ISO datetime）。未設定は締切なし＝常に explore。 */
  deadlineUtc?: string;
  /** 締切前の収束モード（converge）へ切り替える残日数。既定 7。 */
  finalWindowDays: number;
  /** LB スコアの方向。max=大きいほど良い（既定）/ min=小さいほど良い。順位計算に使う。 */
  scoreDirection: 'max' | 'min';
  /**
   * 固定枠（pinned slot）: この JST hour の枠はこのコンペが確定当番になる（動的配分・rotation より
   * 優先）。締切接近コンペへ一定間隔の改善提出サイクルを保証するために使う（例: rogii=6時間ごと）。
   * schedule_hours_jst に含まれる hour だけ有効（parse 時に検証）。
   */
  pinnedHoursJst?: number[];
  /** 固定枠で起案する系統を1つに限定する（例 claude）。未設定なら両系統を起案対象にする。 */
  pinnedLineage?: Lineage;
  /** 検証設定（SOT-2514）。欠落時は fail-safe に `{ primary: 'cv' }`。 */
  validation: CompetitionValidation;
  targets: ImprovementTarget[];
}

/**
 * コンペの検証設定（SOT-2514）。一次KPIの選択と、材料収集が読む leak-free CV レポートの所在、
 * 参照実装スコア（過学習検知の基準）を宣言する。欠落時は fail-safe に `{ primary: 'cv' }`。
 */
export interface CompetitionValidation {
  /**
   * 一次KPI。`cv`=leak-free CV を一次に信じる（既定・hidden private split のコンペは必ず `cv`）／
   * `lb`=public LB を一次にできる例外（public==private 等、リークの無い構成）だけに使う。
   */
  primary: 'cv' | 'lb';
  /** target repo 内の cv_report.json 相対パス（既定 docs/ai/cv_report.json）。 */
  cvReportPath?: string;
  /** 重い裾 metric 名（playbook P3 の頑健受容が診断する対象。説明メタ）。 */
  tailHeavyMetric?: string;
  /**
   * 参照実装/公開NB の公称 public score。自 best public が有意に上回ったら「後付け較正の過学習」を
   * 疑う（playbook P5）。registry 側に置く基準値。
   */
  referencePublicScore?: number;
  /**
   * SOT-2518 P8: このコンペは「有効な（非ゼロ・スコア確定）提出」を成立の前提にする（agent/kernel
   * コンペ既定 true）。true のとき、直近提出が ERROR/0.000/未スコアを連続したら起案本文を
   * submit-repair モードへ切り替える（新規改善軸を止めて提出パイプラインの復旧を最優先にする）。
   */
  requireScoredSubmission?: boolean;
  /**
   * SOT-2519: `submissionHealth=broken` と判定する「先頭から連続する無効提出」の回数（既定
   * `SUBMISSION_BROKEN_CONSECUTIVE`=3）。壊れやすい/提出頻度の低いコンペで感度を上げ下げするための
   * registry 上書き。1 以上の整数。欠落時は fail-safe に既定値。
   */
  brokenSubmissionConsecutive?: number;
  /**
   * SOT-2518 P9: metric の性質。`regression`=絶対スコアが実態（従来挙動）／`relative_rating`=相対
   * rating（field が動くため絶対スコア維持は後退。順位を一次実態とみなす）／`attack`=攻撃系（スコア
   * 成立自体が壊れやすい）。`relative_rating` のとき本文に「維持=後退・前進軸必須」の順位契約を挿入する。
   */
  metricKind?: 'regression' | 'relative_rating' | 'attack';
  /**
   * SOT-2745: oracle-drift の proxy(ローカル指標: leak-free CV)系列で「改善が頭打ち」とみなす最小改善幅
   * （方向つき絶対値）。欠落時は `DEFAULT_PROXY_SATURATION_MIN_IMPROVEMENT`。0 以上の有限数。
   */
  oracleDriftProxyMinImprovement?: number;
  /**
   * SOT-2745: oracle-drift の真の一次KPI(実LB順位)系列で「有意に動いた」とみなす最小改善幅（順位=1つ以上
   * 上げる）。これ未満は停滞。欠落時は `DEFAULT_TRUE_KPI_MIN_IMPROVEMENT`。0 以上の有限数。
   */
  oracleDriftTrueKpiMinImprovement?: number;
}

/**
 * 締切に対するサイクルの位相（design/README.md §51 締切と最終提出選定）。
 *  - `explore`  : 通常の探索（新規軸の起案可）。
 *  - `converge` : 締切まで finalWindowDays 以内。新規軸を止め、検証済み candidate の確定と
 *                 最終提出2枠の選定を優先する。
 *  - `closed`   : 締切超過。起案しない。
 */
export type CompetitionPhase = 'explore' | 'converge' | 'closed';

export interface CompetitionPhaseResult {
  phase: CompetitionPhase;
  daysToDeadline?: number;
}

export function resolveCompetitionPhase(
  competition: Pick<ImprovementCompetition, 'deadlineUtc' | 'finalWindowDays'>,
  nowUtc: string
): CompetitionPhaseResult {
  if (!competition.deadlineUtc) return { phase: 'explore' };
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(competition.deadlineUtc)
    ? Date.parse(`${competition.deadlineUtc}T23:59:59Z`)
    : Date.parse(competition.deadlineUtc);
  const now = Date.parse(nowUtc);
  if (!Number.isFinite(deadline) || !Number.isFinite(now)) return { phase: 'explore' };
  const daysToDeadline = (deadline - now) / 86_400_000;
  if (daysToDeadline < 0) return { phase: 'closed', daysToDeadline };
  if (daysToDeadline <= competition.finalWindowDays) return { phase: 'converge', daysToDeadline };
  return { phase: 'explore', daysToDeadline };
}

/** 枠→コンペ ローテーションの1エントリ。 */
export interface RotationEntry {
  hourJst: number;
  competition: string;
}

/** kaggle_targets_registry.json をパースした形。 */
/**
 * 日次提出枠の効率化ポリシー（完了駆動ループが毎サイクル提出して cap を浪費するのを防ぐ）。
 * - dailyReserve: 自動ループが1日に消費してよいのは `cap - dailyReserve` 枠まで（残りは温存）。0=無効。
 * - minIntervalMin: 直近の提出からこの分数が経過するまで新規提出を抑止（spacing）。0=無効。
 * 改善ゲート（leak-free CV が前回*提出*を上回った時のみ提出）は issue 本文ポリシー＋worker 判断で担保する。
 */
export interface SubmissionPolicy {
  dailyReserve: number;
  minIntervalMin: number;
}

export interface TargetsRegistry {
  /** レジストリ側 kill switch（env とは AND）。 */
  enabled: boolean;
  scheduleHoursJst: number[];
  rotation: RotationEntry[];
  issueCapGuard: number;
  competitions: ImprovementCompetition[];
  /** 適応的資源配分（design §50）。未設定は static（従来の rotation）。 */
  allocation: AllocationConfig;
  /** 日次提出枠の効率化（reserve/spacing）。未設定は {dailyReserve:0, minIntervalMin:0}=無効。 */
  submissionPolicy: SubmissionPolicy;
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

  // pinned 枠の整合性: コンペ間で hour が重複せず、schedule_hours_jst に含まれること
  // （含まれない hour は --only-scheduled で捨てられ、固定枠が黙って動かなくなる）。
  const pinnedSeen = new Map<number, string>();
  for (const comp of competitions) {
    for (const h of comp.pinnedHoursJst ?? []) {
      const prev = pinnedSeen.get(h);
      if (prev !== undefined) {
        throw new Error(
          `registry pinned_hours_jst ${h} is claimed by both "${prev}" and "${comp.key}"`
        );
      }
      pinnedSeen.set(h, comp.key);
      if (!scheduleHoursJst.includes(h)) {
        throw new Error(
          `registry.competitions "${comp.key}" pinned_hours_jst ${h} must be included in schedule_hours_jst`
        );
      }
    }
  }

  const allocation = parseAllocationConfig(obj.allocation);
  const submissionPolicy = parseSubmissionPolicy(obj.submission_policy ?? obj.submissionPolicy);

  return {
    enabled,
    scheduleHoursJst,
    rotation,
    issueCapGuard: capGuardRaw,
    competitions,
    allocation,
    submissionPolicy,
  };
}

/**
 * `submission_policy` を検証。欠落/不正は fail-safe で {dailyReserve:0, minIntervalMin:0}（無効=従来挙動）。
 * dailyReserve は 0 以上の整数、minIntervalMin は 0 以上の数値のみ採用（それ以外は 0 扱い）。
 */
export function parseSubmissionPolicy(raw: unknown): SubmissionPolicy {
  const def: SubmissionPolicy = { dailyReserve: 0, minIntervalMin: 0 };
  if (!raw || typeof raw !== 'object') return def;
  const o = raw as Record<string, unknown>;
  const reserveRaw = o.daily_reserve ?? o.dailyReserve;
  const intervalRaw = o.min_interval_min ?? o.minIntervalMin;
  const dailyReserve =
    typeof reserveRaw === 'number' && Number.isInteger(reserveRaw) && reserveRaw >= 0
      ? reserveRaw
      : 0;
  const minIntervalMin =
    typeof intervalRaw === 'number' && Number.isFinite(intervalRaw) && intervalRaw >= 0
      ? intervalRaw
      : 0;
  return { dailyReserve, minIntervalMin };
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

  const deadlineUtcRaw = co.deadline_utc ?? co.deadlineUtc;
  let deadlineUtc: string | undefined;
  if (deadlineUtcRaw !== undefined) {
    if (typeof deadlineUtcRaw !== 'string' || !Number.isFinite(
      /^\d{4}-\d{2}-\d{2}$/.test(deadlineUtcRaw)
        ? Date.parse(`${deadlineUtcRaw}T00:00:00Z`)
        : Date.parse(deadlineUtcRaw)
    )) {
      throw new Error(
        `registry.competitions[${i}].deadline_utc must be YYYY-MM-DD or an ISO datetime`
      );
    }
    deadlineUtc = deadlineUtcRaw;
  }
  const finalWindowDaysRaw = co.final_window_days ?? co.finalWindowDays ?? 7;
  if (
    typeof finalWindowDaysRaw !== 'number' ||
    !Number.isFinite(finalWindowDaysRaw) ||
    finalWindowDaysRaw < 0
  ) {
    throw new Error(`registry.competitions[${i}].final_window_days must be a non-negative number`);
  }
  const scoreDirectionRaw = co.score_direction ?? co.scoreDirection ?? 'max';
  if (scoreDirectionRaw !== 'max' && scoreDirectionRaw !== 'min') {
    throw new Error(`registry.competitions[${i}].score_direction must be "max" or "min"`);
  }

  const pinnedHoursRaw = co.pinned_hours_jst ?? co.pinnedHoursJst;
  let pinnedHoursJst: number[] | undefined;
  if (pinnedHoursRaw !== undefined) {
    if (
      !Array.isArray(pinnedHoursRaw) ||
      pinnedHoursRaw.length === 0 ||
      !pinnedHoursRaw.every(VALID_HOUR)
    ) {
      throw new Error(
        `registry.competitions[${i}].pinned_hours_jst must be a non-empty array of hours (0-23)`
      );
    }
    pinnedHoursJst = Array.from(new Set(pinnedHoursRaw as number[])).sort((a, b) => a - b);
  }
  const pinnedLineageRaw = co.pinned_lineage ?? co.pinnedLineage;
  let pinnedLineage: Lineage | undefined;
  if (pinnedLineageRaw !== undefined) {
    if (pinnedLineageRaw !== 'claude' && pinnedLineageRaw !== 'gpt') {
      throw new Error(`registry.competitions[${i}].pinned_lineage must be "claude" or "gpt"`);
    }
    if (!pinnedHoursJst) {
      throw new Error(`registry.competitions[${i}].pinned_lineage requires pinned_hours_jst`);
    }
    pinnedLineage = pinnedLineageRaw;
  }

  const validation = parseCompetitionValidation(co.validation, i);

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
    deadlineUtc,
    finalWindowDays: finalWindowDaysRaw,
    scoreDirection: scoreDirectionRaw,
    pinnedHoursJst,
    pinnedLineage,
    validation,
    targets,
  };
}

/**
 * `validation` ブロック（SOT-2514）を検証する。欠落/null は fail-safe に `{ primary: 'cv' }`。
 * 値が存在するのに型不正なら fail-loud（他フィールド同様）。
 */
function parseCompetitionValidation(raw: unknown, i: number): CompetitionValidation {
  if (raw === undefined || raw === null) return { primary: 'cv' };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`registry.competitions[${i}].validation must be an object`);
  }
  const v = raw as Record<string, unknown>;
  const primaryRaw = v.primary ?? 'cv';
  if (primaryRaw !== 'cv' && primaryRaw !== 'lb') {
    throw new Error(`registry.competitions[${i}].validation.primary must be "cv" or "lb"`);
  }
  const validation: CompetitionValidation = { primary: primaryRaw };

  const cvReportPath = v.cv_report_path ?? v.cvReportPath;
  if (cvReportPath !== undefined) {
    if (typeof cvReportPath !== 'string' || !cvReportPath.trim()) {
      throw new Error(
        `registry.competitions[${i}].validation.cv_report_path must be a non-empty string`
      );
    }
    validation.cvReportPath = cvReportPath.trim();
  }

  const tailHeavyMetric = v.tail_heavy_metric ?? v.tailHeavyMetric;
  if (tailHeavyMetric !== undefined) {
    if (typeof tailHeavyMetric !== 'string' || !tailHeavyMetric.trim()) {
      throw new Error(
        `registry.competitions[${i}].validation.tail_heavy_metric must be a non-empty string`
      );
    }
    validation.tailHeavyMetric = tailHeavyMetric.trim();
  }

  const referencePublicScore = v.reference_public_score ?? v.referencePublicScore;
  if (referencePublicScore !== undefined) {
    if (typeof referencePublicScore !== 'number' || !Number.isFinite(referencePublicScore)) {
      throw new Error(
        `registry.competitions[${i}].validation.reference_public_score must be a finite number`
      );
    }
    validation.referencePublicScore = referencePublicScore;
  }

  // SOT-2518 P8: 有効提出を前提にするか（submit-repair モードのゲート）。
  const requireScoredSubmission = v.require_scored_submission ?? v.requireScoredSubmission;
  if (requireScoredSubmission !== undefined) {
    if (typeof requireScoredSubmission !== 'boolean') {
      throw new Error(
        `registry.competitions[${i}].validation.require_scored_submission must be a boolean`
      );
    }
    validation.requireScoredSubmission = requireScoredSubmission;
  }

  // SOT-2519: submissionHealth=broken の連続回数閾値（欠落時は既定3）。
  const brokenSubmissionConsecutive = v.broken_submission_consecutive ?? v.brokenSubmissionConsecutive;
  if (brokenSubmissionConsecutive !== undefined) {
    if (
      typeof brokenSubmissionConsecutive !== 'number' ||
      !Number.isInteger(brokenSubmissionConsecutive) ||
      brokenSubmissionConsecutive < 1
    ) {
      throw new Error(
        `registry.competitions[${i}].validation.broken_submission_consecutive must be an integer >= 1`
      );
    }
    validation.brokenSubmissionConsecutive = brokenSubmissionConsecutive;
  }

  // SOT-2518 P9: metric の性質（relative_rating で順位契約を挿入）。
  const metricKind = v.metric_kind ?? v.metricKind;
  if (metricKind !== undefined) {
    if (metricKind !== 'regression' && metricKind !== 'relative_rating' && metricKind !== 'attack') {
      throw new Error(
        `registry.competitions[${i}].validation.metric_kind must be "regression", "relative_rating", or "attack"`
      );
    }
    validation.metricKind = metricKind;
  }

  // SOT-2745: oracle-drift の proxy/真KPI 最小改善幅の registry 上書き（欠落時は既定値）。
  const odProxy = v.oracle_drift_proxy_min_improvement ?? v.oracleDriftProxyMinImprovement;
  if (odProxy !== undefined) {
    if (typeof odProxy !== 'number' || !Number.isFinite(odProxy) || odProxy < 0) {
      throw new Error(
        `registry.competitions[${i}].validation.oracle_drift_proxy_min_improvement must be a finite number >= 0`
      );
    }
    validation.oracleDriftProxyMinImprovement = odProxy;
  }
  const odTrue = v.oracle_drift_true_kpi_min_improvement ?? v.oracleDriftTrueKpiMinImprovement;
  if (odTrue !== undefined) {
    if (typeof odTrue !== 'number' || !Number.isFinite(odTrue) || odTrue < 0) {
      throw new Error(
        `registry.competitions[${i}].validation.oracle_drift_true_kpi_min_improvement must be a finite number >= 0`
      );
    }
    validation.oracleDriftTrueKpiMinImprovement = odTrue;
  }

  return validation;
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
  const modeRaw = to.mode ?? 'improve';
  if (modeRaw !== 'improve' && modeRaw !== 'maintain') {
    throw new Error(
      `registry.competitions[${ci}].targets[${ti}].mode must be "improve" or "maintain"`
    );
  }
  const stageRaw = to.stage ?? 'improve';
  if (stageRaw !== 'submit-valid' && stageRaw !== 'proxy' && stageRaw !== 'improve') {
    throw new Error(
      `registry.competitions[${ci}].targets[${ti}].stage must be "submit-valid", "proxy" or "improve"`
    );
  }
  const target: ImprovementTarget = {
    lineage,
    repo,
    project,
    workersDirective,
    nextCycle: nextCycleRaw,
    mode: modeRaw,
    stage: stageRaw,
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

/** pinned 枠の解決結果。 */
export interface PinnedSlot {
  competition: string;
  /** 起案対象を1系統に限定する場合の系統（未設定なら両系統）。 */
  lineage?: Lineage;
}

/**
 * 指定 hour(JST) が固定枠（pinned_hours_jst）なら、その確定当番コンペ（と系統限定）を返す。
 * 動的資源配分・rotation より優先される（締切接近コンペの一定間隔サイクル保証用）。
 */
export function resolvePinnedSlotForHour(
  registry: TargetsRegistry,
  hourJst: number
): PinnedSlot | null {
  for (const c of registry.competitions) {
    if (c.pinnedHoursJst?.includes(hourJst)) {
      return { competition: c.key, lineage: c.pinnedLineage };
    }
  }
  return null;
}

/** コンペ key から定義を引く。 */
export function getCompetition(
  registry: TargetsRegistry,
  key: string
): ImprovementCompetition | undefined {
  return registry.competitions.find((c) => c.key === key);
}

/**
 * oracle-drift シグナル（SIGNATE rank-26 post-mortem 由来）。cron の材料収集が、proxy（ローカル指標:
 * leak-free CV / 自作 gold との一致 net など）の飽和と、真の一次KPI（実LB順位 / 真値精度）の停滞を
 * 突き合わせて立てる。**両方が真**かつ停滞が閾値サイクル継続したとき buildIssueBody が再アンカー指令
 * バナーへ切り替える。欠落時は従来挙動（後方互換）。submit-repair とは独立（提出は生存しているが
 * oracle が真値を代表しなくなった状態を捉える）。
 */
export interface OracleDriftSignal {
  /** 飽和している proxy/ローカル指標の名称（表示用。例 "leak-free CV" / "gold100 net"）。 */
  proxyKpiName?: string;
  /** proxy が上限付近で頭打ち（直近サイクルの改善が閾値未満）か。 */
  proxySaturated: boolean;
  /** 真の一次KPIの名称（表示用。例 "public LB 順位" / "private accuracy"）。 */
  trueKpiName?: string;
  /** 真の一次KPI が有意に動いていない（停滞）か。 */
  trueKpiStagnant: boolean;
  /** proxy飽和×真KPI停滞が連続したサイクル数。 */
  stagnantCycles: number;
  /** 人間向けの説明（本文に表示）。 */
  detail?: string;
}

/** cron が収集して渡す1プロジェクトぶんの起案材料（要約なしの生 digest）。 */
export interface ImprovementMaterial {
  /** 前回提出の順位/スコア（Kaggle CLI・best-effort）。「翌日に前回結果を確認」の実体。 */
  previousSubmission?: string;
  /** 直近の Done/In Review Issue ダイジェスト。 */
  recentIssuesDigest?: string;
  /** failure-log / KPI 抜粋。 */
  failureKpiExcerpt?: string;
  /**
   * leak-free CV サマリ（SOT-2513 一次KPI）: エンティティ単位/時系列で hold out した leak-free
   * 検証の CV スコア。未提供なら本文は「CV未整備」fail-safe を表示する。
   */
  cvSummary?: string;
  /** public LB サマリ（design §42 → SOT-2513 で二次sanityへ降格）: best score / rank / top との差 / 順位推移。 */
  leaderboardSummary?: string;
  /**
   * CV↔public 乖離の説明枠（SOT-2513）。gap 値の実供給は次サイクル。本Issueはテンプレ/インターフェース。
   */
  cvPublicGapSummary?: string;
  /**
   * CV と public の乖離量（正規化した絶対値）。閾値超で本文に `⚠ 乖離警告` を挿入する。
   * 実供給は次Issue（本Issueはインターフェースのみ）。
   */
  cvPublicGap?: number;
  /** `⚠ 乖離警告` を出す gap 閾値の上書き（既定 DEFAULT_CV_PUBLIC_GAP_WARN_THRESHOLD）。 */
  cvPublicGapWarnThreshold?: number;
  /**
   * SOT-2514: 自 best public が参照実装/公開NBの public を有意に上回った場合の過学習疑い警告
   * （playbook P5）。CV↔public gap セクションへ挿入する。
   */
  referenceOverfitWarning?: string;
  /**
   * SOT-2514: cv_report 履歴から算出した gap 推移 digest。拡大傾向なら「汎化リスク増大」を含む。
   */
  cvPublicGapTrend?: string;
  /** 実験台帳ダイジェスト（design §48）: 試行済み軸と非昇格軸（再試行禁止リスト）。 */
  experimentLedgerDigest?: string;
  /**
   * 前回サイクル親Issueの申し送りコメント抜粋（`## 申し送り` を含む最新コメント・signate教訓の移植）。
   * 未供給なら本文は「申し送りなし」fail-safe を表示する。
   */
  previousCycleHandoff?: string;
  /**
   * 相手系統（同一コンペの claude↔gpt 逆側）の実験台帳ダイジェスト。系統間 divergence を
   * 相互移植の材料にする（Sonnet↔flash trace 移植の Kaggle 版）。
   */
  counterpartLedgerDigest?: string;
  /**
   * SOT-2518 P8: 直近提出の健全性。`broken`=ERROR/0.000/未スコアが閾値回連続（提出パイプライン破損の
   * 疑い）／`ok`=直近に有効スコア／`unknown`=判定材料不足。`validation.require_scored_submission` の
   * コンペで `broken` のとき、buildIssueBody は submit-repair モードへ切り替える。
   */
  submissionHealth?: 'ok' | 'broken' | 'unknown';
  /** SOT-2518 P8: submissionHealth の人間向け理由（本文に表示する）。 */
  submissionHealthReason?: string;
  /**
   * SOT-2519: 先頭から連続した無効提出（ERROR/0.000/未掲載）の件数。submit-repair 本文先頭の
   * `🔴 提出が壊れています（直近N回…）` マーカーに使う。
   */
  submissionHealthConsecutive?: number;
  /**
   * SOT-2518 P9: 実LB順位のトレンド digest（上昇/低下/新規）。`validation.metric_kind` が
   * `relative_rating` のコンペで「維持=後退」を検知する一次材料。低下傾向なら ⚠ を含む。
   */
  rankTrend?: string;
  /**
   * SOT-2520: 実LB順位トレンドの構造化 direction（`computeRankTrend` の direction）。本文が文字列を
   * sniff せず「順位低下」を判定するために使う。`relative_rating` かつ `declining` のときだけ
   * 本文へ「維持=後退・前進軸必須」の強調警告を挿入する。
   */
  rankTrendDirection?: 'improving' | 'declining' | 'flat' | 'new' | 'unknown';
  /**
   * 日次提出予算のダイジェスト（cron が自動収集）: 本日の提出数 / cap / reserve / 実効枠 / 直近提出時刻・
   * 最小間隔。提出予算ポリシー（改善ゲート＋spacing）を worker が適用するための材料。
   */
  submissionBudget?: string;
  /**
   * oracle-drift シグナル（SIGNATE rank-26 post-mortem）。proxy 飽和 × 真の一次KPI 停滞を突き合わせて
   * 立てる。`detectOracleDrift` が drift と判定すると buildIssueBody は再アンカー指令バナーを先頭に差し込む
   * （proxy を上げる局所A/Bを止め、oracle 再アンカーを唯一の軸に固定）。欠落時は従来挙動（後方互換）。
   */
  oracleDrift?: OracleDriftSignal;
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
  /** 現在時刻（UTC ISO）。締切位相の判定に使う。未指定は現在時刻。 */
  nowUtc?: string;
  /**
   * 動的資源配分（design §50）が選んだコンペ key。指定時は hour→rotation 解決を上書きする。
   * 未指定なら従来どおり rotation 表で hourJst から当番コンペを解決する（後方互換）。
   */
  competitionKeyOverride?: string;
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

/**
 * CV↔public 乖離で `⚠ 乖離警告` を挿入する既定閾値（正規化ギャップの絶対値）。
 * material.cvPublicGapWarnThreshold で上書き可。gap 値の実供給は次サイクル（SOT-2513）。
 */
export const DEFAULT_CV_PUBLIC_GAP_WARN_THRESHOLD = 1;

/** 子Issue本文先頭に固定する worker/reasoning directive（系統ごとに Opus / Sol へ固定）。 */
function childWorkersDirective(target: ImprovementTarget): string {
  return target.lineage === 'claude'
    ? 'workers: solo=claude:opus, handoff=off'
    : 'workers: solo=codex:gpt-5.6-sol, handoff=off\nreasoning: solo=low';
}

/** 起案Issueのタイトル（§6・process 名を避け feature/outcome 起点）。 */
export function buildIssueTitle(target: ImprovementTarget, cycleNumber: number): string {
  return `[${target.repo}] Kaggle順位向上サイクル第${cycleNumber}次 — 改善方針の立案と実施`;
}

/**
 * SOT-2518 P8 — submit-repair モードの起案本文。直近提出が ERROR/0.000/未スコアを連続し、コンペが
 * 有効提出を前提にする（`validation.require_scored_submission`）とき、`buildIssueBody` はこの本文へ
 * 切り替える。新規の改善軸は起案せず、「有効な非ゼロ提出を1本出す」ことだけをゴールに、提出パイプライン
 * （kernel実行・出力パス・exec互換・SDK依存・fingerprint gate）をデバッグする。escalation ladder より優先。
 */
export function buildSubmitRepairBody(
  target: ImprovementTarget,
  competition: ImprovementCompetition,
  cycleNumber: number,
  material: ImprovementMaterial
): string {
  const childWorkers = childWorkersDirective(target);
  const reason =
    material.submissionHealthReason?.trim() ||
    '直近提出が連続して有効スコアを得ていない（ERROR/0.000/未スコア）。';
  const prev =
    material.previousSubmission?.trim() || '(前回提出の記録なし — 取得できずまたは提出履歴が空)';
  const failure = material.failureKpiExcerpt?.trim() || '(該当なし)';
  // SOT-2519: 材料先頭に置く「壊れている」マーカー（連続回数が分かれば直近N回を明記する）。
  const brokenCount = material.submissionHealthConsecutive;
  const brokenHeader =
    typeof brokenCount === 'number' && brokenCount > 0
      ? `🔴 提出が壊れています（直近${brokenCount}回 ERROR/0.000/未掲載）`
      : '🔴 提出が壊れています（直近提出が ERROR/0.000/未掲載）';
  return `workers: ${target.workersDirective}

${brokenHeader}

## 目的（submit-repair モード）
Kaggleコンペ \`${competition.kaggleCompetition}\`（repo: ${target.repo} / 系統: ${target.lineage}）への
提出が壊れている。**新規の改善軸は起案しない。** 唯一のゴールは **有効な（非ゼロ・スコア確定）提出を1本
成立させる**こと。提出が生存するまで、ローカル oracle での軸探索・昇格判断は一切行わない
（提出が LB に載らないまま非昇格判定を積む「空回り」を止める — SOT-2518 P8）。

## 提出健全性シグナル（cronが自動検出）
⚠ ${reason}
- 直近提出（履歴）:
${prev}

## 実施内容（提出パイプラインのデバッグを最優先）
escalation ladder より優先する。次を順に切り分け、**有効な非ゼロ提出が1本 LB に載るまで**繰り返す:
1. **kernel/実行**: 提出 kernel（notebook）がエラーなく最後まで実行され、期待どおりの出力ファイルを
   生成するか（例外・タイムアウト・OOM・依存欠落を潰す）。
2. **出力パス/フォーマット**: 提出物のパス・列・行数・dtypes が sample_submission と一致するか。
3. **exec互換**: \`exec\`/\`__file__\` 非依存・cwd 不定でも動くか（[[kaggle-exec-runtime-gate]]）。
4. **SDK/依存**: 競技 SDK（例 \`aicomp_sdk\`）が serving/exec 環境で import 可能か。system Python でなく
   repo の \`.venv/bin/python\` で確認する。
5. **提出経路**: 必ず control-plane の
   \`bash scripts/ai/kaggle_targets_submit.sh --competition ${competition.key} --repo ${target.repo} --execute\`
   を使う。Kaggle CLI/API を直接呼んで fingerprint gate を迂回しない。提出後、Kaggle 上で status が
   COMPLETE かつ publicScore が非ゼロ（＝ LB 掲載）になったことを**必ず実測で確認**する。

## 失敗ログ・KPI抜粋
${failure}

## 実行リソース
- 改善の実装・学習・検証では GPU の使用を許可する。web 検索で公開 kernel/discussion の提出エラー
  事例を調査してよいが、目的は「有効提出の成立」に限定する（スコア改善ではない）。

## 子Issueへの委譲
提出復旧の作業を 1〜3個の子Issueに分解して登録してよい（各子は Kaggle 提出を実行しない — 提出は親のみ）。
各子Issueの本文先頭には必ず次の directive を記載する:

\`\`\`
${childWorkers}
\`\`\`

## 受け入れ条件
- [ ] 提出が壊れていた根本原因（kernel/出力/exec/SDK/経路のいずれか）が特定され、記録されている
- [ ] control-plane の提出スクリプト経由で提出し、Kaggle 上で status=COMPLETE かつ publicScore が
      非ゼロ（LB 掲載）になったことを実測で確認した、または未解決の残課題が具体的に記録されている
- [ ] 有効提出が成立するまで新規の改善軸を起案していない

## 関連
- 親（改善サイクル設計）: SOT-1913 / このサイクル自動起案の起点（第${cycleNumber}次・submit-repair）`;
}

/** oracle-drift の判定レベル。none=通常 / reanchor=再アンカー強制 / escalate=人間へエスカレーション。 */
export type OracleDriftLevel = 'none' | 'reanchor' | 'escalate';

/** detectOracleDrift の結果。 */
export interface OracleDriftResult {
  level: OracleDriftLevel;
  /** level !== 'none'。 */
  drifting: boolean;
  reason: string;
}

/** proxy飽和×真KPI停滞が「再アンカー強制」に至る連続サイクル数の既定閾値。 */
export const DEFAULT_ORACLE_DRIFT_REANCHOR_CYCLES = 2;
/** proxy飽和×真KPI停滞が「人間エスカレーション」に至る連続サイクル数の既定閾値。 */
export const DEFAULT_ORACLE_DRIFT_ESCALATE_CYCLES = 4;

/**
 * oracle-drift（proxy飽和 × 真の一次KPI停滞）を決定論的に判定する純粋関数（SIGNATE rank-26 post-mortem）。
 * **両方**（proxySaturated かつ trueKpiStagnant）が真のときだけドリフトとみなす（片方だけ＝通常の改善余地/
 * 汎化ギャップは既存の gap 警告が扱う）。停滞サイクル数が escalateCycles 以上なら 'escalate'、reanchorCycles
 * 以上なら 'reanchor'、未満は 'none'。signal 欠落は 'none'（後方互換）。
 */
export function detectOracleDrift(
  signal: OracleDriftSignal | undefined,
  opts?: { reanchorCycles?: number; escalateCycles?: number }
): OracleDriftResult {
  if (!signal) return { level: 'none', drifting: false, reason: 'no oracle-drift signal' };
  if (!signal.proxySaturated || !signal.trueKpiStagnant) {
    return {
      level: 'none',
      drifting: false,
      reason: 'oracle-drift requires proxy saturated AND true KPI stagnant',
    };
  }
  const reanchorAt =
    opts?.reanchorCycles && opts.reanchorCycles > 0
      ? Math.floor(opts.reanchorCycles)
      : DEFAULT_ORACLE_DRIFT_REANCHOR_CYCLES;
  const escalateAt =
    opts?.escalateCycles && opts.escalateCycles > 0
      ? Math.floor(opts.escalateCycles)
      : DEFAULT_ORACLE_DRIFT_ESCALATE_CYCLES;
  const cycles =
    Number.isFinite(signal.stagnantCycles) && signal.stagnantCycles > 0
      ? Math.floor(signal.stagnantCycles)
      : 0;
  if (cycles >= escalateAt) {
    return {
      level: 'escalate',
      drifting: true,
      reason: `proxy saturated & true KPI stagnant for ${cycles} cycle(s) (>= ${escalateAt}); escalate to human`,
    };
  }
  if (cycles >= reanchorAt) {
    return {
      level: 'reanchor',
      drifting: true,
      reason: `proxy saturated & true KPI stagnant for ${cycles} cycle(s) (>= ${reanchorAt}); force oracle re-anchor`,
    };
  }
  return {
    level: 'none',
    drifting: false,
    reason: `proxy saturated & true KPI stagnant for ${cycles} cycle(s) (< ${reanchorAt})`,
  };
}

/**
 * oracle-drift バナー（SIGNATE rank-26 post-mortem）。ドリフト時に buildIssueBody 本文の先頭（workers
 * ディレクティブ直後）へ差し込む強制再アンカー指令。proxy を上げる局所A/B・per-idx回収の新規起案を禁止し、
 * 今サイクルの唯一の軸を escalation ladder (2) データ/oracle 再アンカーに固定する。level=escalate では
 * 加えて人間エスカレーションを指示する。drifting=false のとき空文字（先頭 `\n\n`・末尾改行なしで返す）。
 */
export function buildOracleDriftBanner(
  signal: OracleDriftSignal | undefined,
  result: OracleDriftResult
): string {
  if (!signal || !result.drifting) return '';
  const proxy = signal.proxyKpiName?.trim() || 'ローカル proxy/CV';
  const trueKpi = signal.trueKpiName?.trim() || '真の一次KPI（実LB順位/真値精度）';
  const cycles =
    Number.isFinite(signal.stagnantCycles) && signal.stagnantCycles > 0
      ? Math.floor(signal.stagnantCycles)
      : 0;
  const detail = signal.detail?.trim();
  const escalate = result.level === 'escalate';
  const header = escalate
    ? '🔻🔻 ORACLE DRIFT（エスカレーション）— proxy 最適化を捨て、真KPIへ再アンカーし人間へ判断を要請'
    : '🔻 ORACLE DRIFT 検知 — proxy 最適化を凍結し oracle を再アンカーせよ';
  const escalateLines = escalate
    ? `
- **人間へエスカレーション**（proxy飽和×真KPI停滞が${cycles}サイクル継続）: \`## 申し送り\` コメントの
  先頭に \`⚠ ORACLE-DRIFT ESCALATION\` を明記し、(a) 現 proxy が真KPIを代表していない証拠、(b) oracle 再構築
  もしくはコンペ方針転換の選択肢、を人間の判断材料として提示する（承認待ちでブロックはせず、安全側
  デフォルト＝再アンカー継続で進む）。`
    : `
- 再アンカー後は proxy を作り直し、**真KPI と連動する**ことを確認してから通常の改善サイクルへ戻す。`;
  return `

${header}
- 飽和している proxy: **${proxy}**（頭打ち＝これ以上上げても真KPIは動かない可能性大）
- 停滞している真の一次KPI: **${trueKpi}**（約${cycles}サイクル停滞）${detail ? `\n- 詳細: ${detail}` : ''}

**この状態では proxy を上げる局所A/B・per-idx回収を新規に起案してはならない。** proxy と真KPI が乖離
＝オラクル（gold/正解ラベル/検証holdout）が真値を代表していない疑い。SIGNATE で proxy net を99まで上げても
真値精度は88.5%停滞（26位/962）という実事故の再発防止。今サイクルの唯一の軸を
**escalation ladder (2) データ/oracle 再アンカー**に固定する:
- oracle の**真値妥当性を独立に再検証**する（意味的一致でなく厳格judge基準／複数独立解の逐語majority／
  held-out 実測）。proxy を疑い、oracle 側の系統誤りを探す。
- 真KPI を直接動かす材料（真の誤り修正・分布の穴）を探し、proxy 一致度の改善を成果にしない。${escalateLines}`;
}

/** 起案Issue本文テンプレート（§6・材料 digest を埋め込む。要約はしない）。 */
/**
 * 「行き詰まり（plateau/停滞）」判定（純粋関数）。改善が頭打ちのシグナルを material から導出する:
 *  - oracle-drift（proxy飽和×真KPI停滞）が発火している、または
 *  - 実LB順位トレンドが declining / flat（上昇していない）。
 * 早期サイクル（rankTrend が new/unknown）は「行き詰まり」と判定しない（誤発火防止）。
 */
export function isImprovementStuck(
  material: ImprovementMaterial
): { stuck: boolean; reason: string } {
  const drift = detectOracleDrift(material.oracleDrift);
  if (drift.drifting) {
    return { stuck: true, reason: `proxy飽和×真KPI停滞（oracle-drift: ${drift.level}）` };
  }
  if (material.rankTrendDirection === 'declining') {
    return { stuck: true, reason: '実LB順位が低下傾向' };
  }
  if (material.rankTrendDirection === 'flat') {
    return { stuck: true, reason: '実LB順位が停滞（flat）' };
  }
  return { stuck: false, reason: '' };
}

/**
 * 行き詰まり検知時（isImprovementStuck）に、**過去の Kaggle 上位解法の調査・移植を今サイクルの優先軸に
 * 固定する**プロミネントなバナーを返す（非行き詰まり時は空文字）。常時汎用の「web検索で上位解法を調査」
 * 指示（## 実施内容 / ## 実行リソース）と違い、行き詰まり時にだけ本文冒頭へ前面化して発火する。
 */
export function buildStuckExternalSolutionsBanner(
  competition: ImprovementCompetition,
  material: ImprovementMaterial
): string {
  const s = isImprovementStuck(material);
  if (!s.stuck) return '';
  return `

## 🔺 行き詰まり検知 — 過去の Kaggle 上位解法を最優先で参照・移植せよ
本サイクルは行き詰まり兆候（${s.reason}）を検知した。局所チューニングの継続は禁止し、**今サイクルの主軸を
「このコンペ（\`${competition.kaggleCompetition}\`）の過去 Kaggle 上位解法の調査と移植」に固定**する
（escalation ladder の「外部知識取り込み」を前倒しする）:
- web検索で **上位解法**（優勝／上位入賞の write-up・Kaggle Discussion の Solution スレッド・公開 gold/銀銅
  kernel・関連論文）を調査し、勝ち筋（前処理・特徴量・モデル・後処理・**CV設計**）の要点を出典URLとともに
  target repo の \`docs/ai/experiment_ledger.jsonl\` へ記録する。
- 有効な手法を **1つ以上、具体的に移植** する子Issueを立てる。移植可否は可搬性（ロジック/データ蒸留=可搬・
  GPU weights 等=非可搬）と本 repo の実行制約（オフライン提出・依存関係）の下で成立するかを見極める。
- 既に台帳で **rejected の軸は新しい根拠なしに再試行しない**。移植した手法の出典・要点は台帳の evidence に残す。`;
}

export function buildIssueBody(
  target: ImprovementTarget,
  competition: ImprovementCompetition,
  cycleNumber: number,
  material: ImprovementMaterial,
  phase?: CompetitionPhaseResult
): string {
  // SOT-2518 P8: 提出が壊れていて（broken）かつコンペが有効提出を前提にする（require_scored_submission）
  // なら、新規改善軸を止めて提出復旧を最優先にする submit-repair モードへ切り替える。
  // stage=submit-valid（段階目標ステート）は submissionHealth に依らず submit-repair 本文へ固定する
  // （有効提出が成立するまで改善軸を凍結 — agent-security 全提出ERROR空回りの再発防止）。
  if (
    target.stage === 'submit-valid' ||
    (material.submissionHealth === 'broken' &&
      competition.validation.requireScoredSubmission === true)
  ) {
    return buildSubmitRepairBody(target, competition, cycleNumber, material);
  }
  // oracle-drift（proxy飽和×真KPI停滞）検知時は、本文先頭に強制再アンカー指令バナーを差し込む。
  // submit-repair の後に評価する（提出が壊れているうちは真KPIを測れず drift 判定が無意味なため）。
  const oracleDriftBanner = buildOracleDriftBanner(
    material.oracleDrift,
    detectOracleDrift(material.oracleDrift)
  );
  // 行き詰まり（plateau/停滞）検知時: 過去の Kaggle 上位解法の参照・移植を優先軸に固定するバナーを前面化。
  // proxy 確立モードは目標が CV 構築なので発火させない（外部解法探索より基盤整備を優先）。
  const stuckBanner =
    target.stage === 'proxy' ? '' : buildStuckExternalSolutionsBanner(competition, material);
  const childWorkers = childWorkersDirective(target);
  const prev =
    material.previousSubmission?.trim() || '(前回提出の記録なし — 初回サイクル、または取得できず)';
  const submissionBudget =
    material.submissionBudget?.trim() ||
    '(本日の提出予算は未取得 — 残枠/直近提出を確認できない場合は保守的に。改善ゲート＝leak-free CVが前回提出を上回った時のみ提出)';
  const recent = material.recentIssuesDigest?.trim() || '(新規の完了Issueなし)';
  const failure = material.failureKpiExcerpt?.trim() || '(該当なし)';
  // 一次KPI = leak-free CV。未整備なら fail-safe（最初の子IssueでCV構築を必須にする）。
  const cv =
    material.cvSummary?.trim() ||
    'CV未整備 — 最初の子Issueでleak-freeなCV（エンティティ単位/時系列 holdout）構築を必須とする。CVを作るまで昇格判断しない';
  const leaderboard =
    material.leaderboardSummary?.trim() ||
    '(public LB を取得できず — CLI疎通/認証を確認。public は二次sanity)';
  // SOT-2520: 実LB順位トレンドは専用セクション（### 実LB順位トレンド）で提示する（順位/総数/推移）。
  const rankTrendBody = material.rankTrend?.trim()
    || '(順位トレンド未取得 — 2観測以上で供給。public LB の CLI 疎通/認証を確認。実LB順位が一次材料)';
  // SOT-2520: 相対 rating コンペ かつ 実LB順位が低下傾向のときだけ、maintain=後退の強調警告を挿入する。
  const maintainRegressWarn =
    competition.validation.metricKind === 'relative_rating' &&
    material.rankTrendDirection === 'declining'
      ? '\n\n⚠ 相対rating comp: champion維持は field改善下で後退。順位低下傾向のため maintain を昇格根拠にせず、必ず前進軸を選べ。opponent field に上位公開解法を取り込み評価fieldを更新せよ。'
      : '';
  // SOT-2518 P9: 相対 rating コンペでは「維持=後退」の順位契約を挿入する（regression は挿入しない）。
  const relativeContract = competition.validation.metricKind === 'relative_rating'
    ? `

### 相対競技の順位契約（維持=後退・SOT-2518 P9）
このコンペは **relative_rating**（対戦 rating / 相対採点）。field（対戦相手・他チーム）が改善し続けるため、
**ローカル固定 field の R\\* 非劣化＝「champion 維持」は、実LBでは後退**でありうる。したがって:
- **維持を昇格根拠にしない。** 実LB順位が低下傾向のときは maintain（現状維持）を成果として扱わず、
  **必ず前進軸（勝率/rating を上げる実質改善）を選ぶ。**
- opponent field に**上位の公開解法・強い相手を取り込み**、固定 field への過適合を避ける。
- **実LB順位の非劣化を昇格の必須条件**にする（ローカル固定 field の R\\* 非劣化だけでは不十分）。`
    : '';
  // CV↔public gap 表示枠（SOT-2513）。gap 値の実供給は次サイクル。閾値超なら乖離警告を前置。
  const gapSummary =
    material.cvPublicGapSummary?.trim() ||
    '(gap 値は次サイクルで供給予定 — CVとpublicを突き合わせ、乖離時はCVを信じる)';
  const gapThreshold = material.cvPublicGapWarnThreshold ?? DEFAULT_CV_PUBLIC_GAP_WARN_THRESHOLD;
  const gapWarn =
    typeof material.cvPublicGap === 'number' &&
    Number.isFinite(material.cvPublicGap) &&
    Math.abs(material.cvPublicGap) >= gapThreshold
      ? '⚠ 乖離警告: CV↔public が大きく乖離。public 追いを止め、悲観側(CV)を信じる。escalation ladder の「汎化ギャップ診断」を優先する。\n'
      : '';
  // SOT-2514: 参照実装 public 超過（P5）の過学習疑い警告 / gap 推移。
  const refWarn = material.referenceOverfitWarning?.trim()
    ? `${material.referenceOverfitWarning.trim()}\n`
    : '';
  const gapTrend = material.cvPublicGapTrend?.trim()
    ? `\n${material.cvPublicGapTrend.trim()}`
    : '';
  const ledger = material.experimentLedgerDigest?.trim()
    || '(実験台帳なし — 初回サイクル、または未整備。今回から docs/ai/experiment_ledger.jsonl へ記録すること)';
  // 申し送りループ（signate Sonnetサイクル教訓）: 前回親Issueの判断・次の軸・閉じた軸を引き継ぐ。
  const handoff = material.previousCycleHandoff?.trim()
    || '(前回サイクルの申し送りなし — 初回サイクル、または前回が申し送りコメントを残していない)';
  // 系統間 divergence 活用: 相手系統（claude↔gpt）の台帳から昇格済み軸の移植候補を提示する。
  const counterpartLedger = material.counterpartLedgerDigest?.trim()
    ? `

### 相手系統の実験台帳（系統間divergence — 相互移植候補）
同一コンペのもう一方の系統（claude↔gpt）の試行状況。**相手系統で promoted（昇格済み）の軸は、
自系統への移植を新規軸より優先して検討**する（移植時は自系統の台帳へ port 元を記録）。相手系統で
rejected の軸に自系統で再挑戦する場合は、系統差で結果が変わる根拠を明示すること。
${material.counterpartLedgerDigest.trim()}`
    : '';
  // 段階目標 proxy: leak-free CV/ローカルproxy 確立が唯一の目標（改善軸・昇格判断を凍結）。
  const proxyStageBanner = target.stage === 'proxy'
    ? `

## 段階目標: proxy 確立モード（stage=proxy）
このターゲットの現在の唯一の目標は **leak-free CV / ローカル proxy の確立**である。proxy が確立する
（cv_report.json がスキーマを満たし、エンティティ単位 hold-out の CV が出る）まで:
- 新規の改善軸・スコア向上の子Issueを起案しない（proxy 構築・検証の子Issueのみ）
- 昇格判断・champion 更新を行わない
- proxy 確立を確認したら、完了報告で registry の \`stage\` を \`improve\` へ進める提案を明記する`
    : '';
  const convergeMode = phase?.phase === 'converge'
    ? `

## 収束モード（締切まで残り約${Math.max(0, Math.floor(phase.daysToDeadline ?? 0))}日）
締切接近のため探索から収束へ切り替える（design/README.md §51 / SOT-2516）:
- 新規の改善軸は起案しない。検証済み candidate の確定・最終化を優先する。
- リスクの高い大規模変更（アーキテクチャ変更・学習やり直し）は開始しない。
- **最終2枠の分散契約（CV最良×hedge）**: 最終提出2枠は「① leak-free CV 最良」×「② 性質の異なる hedge 候補
  （手法/前提が①と独立なもの）」で必ず分散する。**両方を public 最良で選抜することは禁止**（public↔private が
  逆転して全滅した rogii パターンの再発防止 — [[rogii-final-submission-w030-perwell-adaptive]]）。選抜理由を記録する。
- **ノイズ幅追い禁止**: 候補と cutoff（メダル境界等）の差が LB のノイズ幅未満のとき、その差を埋めることを目標にした
  子Issue を起案しない（測定不能な差の最適化に枠を使わない）。
- **drop-dead 運用**: 日次提出上限の1枠を温存し、締切2.5時間前の drop-dead 時刻で、検証済み最良 artifact を
  無条件に提出する（未提出のまま締切を跨がない）。
- **締切間際の採点ラグ**: 締切2.5h前以降の提出は採点が締切後になり、Kaggle の自動最終選抜に入らない可能性がある。
  その場合は親Issueへ「Web で手動最終選抜を依頼」する定型コメントを残す（返答は待たず、安全側デフォルトで進む）。
- **final-selection report 契約**: 提出直前に親Issueへ \`CV最良=X / public最良=Y / gap=Z / 選抜=[...] / 理由\`
  の定型コメントを投稿する。これは人間の介入機会であり、承認待ちでブロックはしない（返答が無ければ安全側で提出）。`
    : '';
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
  const securityEvaluationContract = competition.key === 'agent-security'
    ? `

## Agent Security再開ゲート（恒久契約）
- 作業は参加中のKaggle競技repoと、公式 \`aicomp_sdk\` のローカル合成fixtureに限定する。
- 子Issueは新しい攻撃手順、認可回避、credential取得、第三者システムへの操作を起案しない。
- 改善候補は親Issueの入力材料にID・SHA・評価条件が固定済みのvariantだけを扱う。未固定なら実装せず親へ差し戻す。
- 実行前にcontrol-planeから \`bash scripts/ai/agent_security_preflight.sh <repo-path>\` を実行し、
  repoの \`.venv/bin/python\` で \`import aicomp_sdk\` とdistribution versionを確認する。
  system Pythonや誤ったmodule名 \`aicomp\` のimport結果をSDK不在判定に使わない。
- 評価は外向き通信を無効化した隔離環境で行い、artifactには集計値・真偽値・hashだけを保存する。
- 上記ゲートの成否を親Issueへ記録する。失敗時は提出せず、具体的な不足条件をBlocked理由にする。`
    : '';
  return `workers: ${target.workersDirective}${oracleDriftBanner}${stuckBanner}

## 目的
Kaggleコンペ \`${competition.kaggleCompetition}\`（repo: ${target.repo} / 系統: ${target.lineage}）の
順位を向上させる次の改善方針を決定し、子Issueに分解して実施する。${proxyStageBanner}

## 入力材料（cronが自動収集・要約なし）
### 前回サイクルの申し送り（必読 — 前任の判断・次の軸・閉じた軸）
${handoff}
### 検証階層（一次=leak-free CV / 二次=public LB）
一次KPI = **leak-free CV**（エンティティ単位・時系列で hold out した leak-free 検証）。public LB は
**二次 sanity** に過ぎない。**CVと public が乖離したら悲観側(CV)を信じる。public 追い（public best 選抜）禁止。**
- 一次（信じる指標）leak-free CV: ${cv}
- 二次（sanity のみ）public LB: ${leaderboard}${relativeContract}

### 実LB順位トレンド（実LB順位が一次材料・SOT-2518 P9/SOT-2520）
${rankTrendBody}${maintainRegressWarn}

### CV↔public gap（乖離監視）
${gapWarn}${refWarn}${gapSummary}${gapTrend}

### 前回提出結果（順位/スコア）
${prev}

### 本日の提出予算（日次枠効率化 — 改善ゲート＋spacing/reserve）
${submissionBudget}

### 実験台帳ダイジェスト（試行済み軸 — 非昇格軸の再試行禁止）
${ledger}${counterpartLedger}

### 直近の完了Issueダイジェスト
${recent}

### 失敗ログ・KPI抜粋
${failure}
${abEvaluation}
${securityEvaluationContract}
${convergeMode}

## 実施内容
**人間コメント尊重契約（newest-wins・SOT-2516）**: 人間の承認待ちでブロックはしないが、人がこのIssueに
コメントしたら必ず読まれ・反映される。次の3つの意思決定ポイントで **その直前に Issue コメントを再取得** し、
新しい人間コメントがあれば最新指示を優先する（newest-wins）:
- (a) 改善軸を選定する時、
- (b) 親の再開run で全子Issueの結果を集約する時、
- (c) 提出直前。
また、コメント先頭行の軽量 directive を尊重する（既存 \`workers:\` directive と同系・newest-wins・大文字小文字非依存）:
\`cycle=pause\` / \`cycle=stop\`（サイクル続行判定に接続）・\`submit=hold\`（提出をスキップし理由を親へ記録。
再開は \`submit=auto\`）。これらは**コメントの先頭行**でのみ有効で、長文コメント中への埋め込みは検出しない
（auto-accept の \`review=human\` と同じ既知の罠を避けるための仕様）。
**提出前チェックリスト必須**: 提出前に必ず \`docs/kaggle-playbook/README.md\` の「提出前チェックリスト」を
通過する（leak-free CV の有無・CVとpublicのオーダー一致・乖離時はCVを信じる・重い裾metricの頑健受容・
最終2枠を CV最良×hedge で分散）。未整備の項目があれば最初の子Issueで整備する。
1. 上記材料から未着手の改善軸を選定する。軸の選定にあたっては必ず web 検索を行い、Kaggle の上位
   ノートブック（公開 kernel・上位解法の write-up・discussion）を積極的に調査して、外部の有効な手法を
   改善軸の候補に含める（実験台帳を必ず参照し、非昇格済み軸の再試行は新しい根拠を明示。
   ローカルCVが飽和しているのに public LB が乖離/低下している場合は oracle ドリフト・汎化ギャップを疑い、
   局所A/Bを続けず再アンカリング（holdout/GT再整備・評価系再構築）を軸に選ぶ。CVと乖離した public は
   追わない。連続非昇格が続く場合は escalation ladder の次の段へ強制的に進む:
   (1) 局所チューニング → (2) データ/oracle整備(CV再アンカリング)
   → (3) 汎化ギャップ診断(local↔public gapを作る層の特定・除去)
   → (4) 問題定式化の見直し(点推定vs条件付き分布/恒等式/合成データ — playbook 03参照)
   → (5) アーキテクチャ変更 → (6) 外部知識取り込み(portが参照publicを上回ったら過学習疑い)）。
   選定した軸・仮説・結果は target repo の \`docs/ai/experiment_ledger.jsonl\` へ JSONL で追記する
   （fields: recordedAt, axis, result=promoted|rejected|inconclusive, cycle, hypothesis, evidence）。
   **失敗帰属の証拠要件（rejected/CLOSED 判定の規律）**: 軸を rejected または恒久 CLOSED と記録する場合は、
   (a) 同一 seed の直接 A/B、または (b) 変更の発火/介入が記録された単独アブレーション、のいずれかを
   evidence に示すこと。単一の結合実測（複数変更同時ON）や自己申告の推測だけで rejected にしない —
   証拠が無い場合は **inconclusive 止まり**とし、再検証可能な状態で台帳へ残す（誤REJECTによる有効軸の
   永久喪失を防ぐ）。
2. 2〜5個の実装・検証子Issueに分解して登録（子Issue記述テンプレ・screen→confirmゲート・
   非昇格時 revert+docs・昇格時 exec互換を全子に継承）。子IssueはKaggle提出を実行してはならない。
   各子Issueの本文先頭には必ず次のdirectiveを記載し、分解後の全工程を指定モデル・reasoningへ固定する。

\`\`\`
${childWorkers}
\`\`\`
3. 初回runは子Issue登録後に提出せず In Review で待機する。全子Issueが In Review/Doneへ到達すると
   webhookが \`<!-- auto-parent-resumed -->\` コメントを付けて親をTodoへ戻す。再開runでは子Issueを
   再作成せず、全子Issueの完了と検証結果を再取得・集約する。
   **【提出予算ポリシー — 日次枠を効率的に使う（毎サイクル提出しない）】**
   - **改善ゲート（必須）**: 提出するのは **leak-free CV（一次KPI）が前回*提出*artifactをノイズ幅を超えて
     上回った＝champion 昇格**が確認できた時 **だけ**。改善が無い／ノイズ幅内のサイクルは **提出せず**、
     「非昇格・提出見送り」を親へ記録して次サイクルの局所改善へ回す（artifact fingerprint が前回提出と
     同一の場合も同様に提出しない）。
   - **日次枠(cap)の予約・スペーシング**: 下記「## 本日の提出予算」の残枠・reserve・直近提出からの経過を必ず
     確認する。reserve 枠は温存し（終盤のより強い候補用）、直近提出から最小間隔が未経過なら見送る。
     枠が残り少ない時は「ノイズ幅ギリギリの小改善」で枠を消費しない（大きな改善のみ提出）。
   - 見送り時は cron/ガードが自動で次サイクルを回すので、**枠を無理に使い切らない**こと。
   提出は必ず control-plane の
   \`bash scripts/ai/kaggle_targets_submit.sh --competition ${competition.key} --repo ${target.repo} --execute\`
   を使用する（reserve/spacing/cap/fingerprint は plan 側でも決定論的にゲートされる）。Kaggle CLI/APIを
   直接呼び出して fingerprint/cap/reserve/spacing gate を迂回してはならない。
   **effective-config fingerprint（提出物と設定の突合）**: 提出する artifact を生成した有効設定
   （パラメータ・フラグ・モデル/データ版）の要約を \`docs/ai/experiment_ledger.jsonl\` の提出エントリへ
   記録する（意図した設定と実際に有効だった設定の乖離事故 — 未export フラグ等 — を事後検証可能にする）。
4. 親による集約・提出判定後、親を In Review にして完了報告。**完了報告とは別に、本Issueへ
   \`## 申し送り\` コメントを必ず残す**（内容: 次サイクルの軸候補 / 今回 rejected・CLOSED にした軸と証拠 /
   未検証の仮説 / 運用上の注意）。次サイクルの起案本文に自動転記される。

## 実行リソース
- 改善の実装・学習・検証では GPU の使用を許可する。
- 改善方針の検討では必ず web 検索を行い、Kaggle の上位ノートブック（公開 kernel・上位解法の
  write-up・discussion）を積極的に調査・活用する。有効な手法は本 repo の実行制約（オフライン提出・
  依存関係等）の下で移植する。スコア源が可搬（ロジック/データ蒸留）か非可搬（GPU weights 等）かを
  見極めてから取り込むこと。

## 受け入れ条件
- [ ] 改善方針と選定理由がコメントに記録されている
- [ ] 子Issueが登録され、全て終端状態に達している
- [ ] 提出した candidate/champion と検証結果の対応が記録されている（提出時は effective-config fingerprint を台帳へ記録）
- [ ] 親の再開runが全子Issue完了を確認し、新artifactを提出した、または非昇格・新artifactなしを明記した
- [ ] rejected/CLOSED 判定に証拠（同seed A/B or 発火記録つき単独アブレーション）が付いている（無ければ inconclusive）
- [ ] 本Issueへ \`## 申し送り\` コメント（次の軸候補 / 閉じた軸と証拠 / 未検証仮説）を残した
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
  /** 日次提出枠の効率化ポリシー（reserve/spacing）。未指定は registry.submissionPolicy を使わない=無効。 */
  submissionPolicy?: SubmissionPolicy;
  /** spacing 判定の現在時刻(epoch ms)。未指定なら spacing ゲートは評価しない（テスト決定性のため注入）。 */
  nowEpochMs?: number;
  /** repo ごとの直近提出時刻(epoch ms)。spacing ゲートで参照。 */
  lastSubmitEpochMsByRepo?: Readonly<Record<string, number>>;
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
      // 日次枠効率化（SOT: 完了駆動ループの毎サイクル提出で cap 浪費を防ぐ）。
      const policy = opts.submissionPolicy;
      const reserve = Math.max(0, policy?.dailyReserve ?? 0);
      const effectiveCap = Math.max(1, competition.dailySubmissionCap - reserve);
      const competitionSubmitted = opts.competitionSubmittedToday ?? 0;
      // spacing: 直近提出から minIntervalMin 未満なら抑止（now 未注入時は評価しない）。
      const minIntervalMin = Math.max(0, policy?.minIntervalMin ?? 0);
      const lastSubmitMs = opts.lastSubmitEpochMsByRepo?.[t.repo];
      const spacingBlocked =
        minIntervalMin > 0 &&
        typeof opts.nowEpochMs === 'number' &&
        typeof lastSubmitMs === 'number' &&
        opts.nowEpochMs - lastSubmitMs < minIntervalMin * 60_000;
      const spacingRemainMin =
        spacingBlocked && typeof lastSubmitMs === 'number' && typeof opts.nowEpochMs === 'number'
          ? Math.ceil((minIntervalMin * 60_000 - (opts.nowEpochMs - lastSubmitMs)) / 60_000)
          : 0;
      return competitionSubmitted >= competition.dailySubmissionCap
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
        : reserve > 0 && competitionSubmitted >= effectiveCap
          ? {
              competition: competition.key,
              kaggleCompetition: competition.kaggleCompetition,
              repo: t.repo,
              lineage: t.lineage,
              action: 'skip' as const,
              cap: competition.dailySubmissionCap,
              submittedToday,
              reason: `daily reserve held (${competitionSubmitted}/${competition.dailySubmissionCap}, reserve ${reserve} — auto-loop uses ≤${effectiveCap}/day; save slots for a stronger later candidate)`,
            }
          : spacingBlocked
            ? {
                competition: competition.key,
                kaggleCompetition: competition.kaggleCompetition,
                repo: t.repo,
                lineage: t.lineage,
                action: 'skip' as const,
                cap: competition.dailySubmissionCap,
                submittedToday,
                reason: `submission spacing: last submit <${minIntervalMin}min ago (retry in ~${spacingRemainMin}min) — hold to spread the daily budget`,
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

  // 固定枠（pinned slot）＞動的配分（§50）＞rotation 表の優先順で当番コンペを解決する。
  const pinned = resolvePinnedSlotForHour(registry, hourJst);
  const competitionKey =
    pinned?.competition ??
    input.competitionKeyOverride ??
    resolveCompetitionForHour(registry, hourJst);

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

  const phase = resolveCompetitionPhase(competition, input.nowUtc ?? new Date().toISOString());

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

    // 固定枠の系統限定: pinned_lineage が設定された枠では、その系統だけを起案対象にする。
    if (pinned?.lineage && t.lineage !== pinned.lineage) {
      return {
        ...common,
        action: 'skip' as const,
        reason: `pinned slot: ${pinned.lineage} lineage only`,
      };
    }

    // 締切超過コンペには起案しない（design §51）。提出も締切後は意味を持たない。
    if (phase.phase === 'closed') {
      return {
        ...common,
        action: 'skip' as const,
        reason: `competition deadline passed (deadline_utc=${competition.deadlineUtc})`,
      };
    }

    // maintenance モード（design §49）: escalation ladder を尽くして飽和した系統は新規起案せず、
    // 維持提出だけを続ける。資源（cron枠・compute）は improve モードの系統へ回る。
    if (t.mode === 'maintain') {
      return {
        ...common,
        action: 'skip' as const,
        reason: 'maintenance mode: lineage saturated — no new improvement cycles (submissions continue)',
      };
    }

    // 重複防止: 同じ project に稼働中の auto-improve 親があれば重複起案しない。
    // Issue cap / cooldown / 新材料 / 測定不能では止めない（「基本は起案する」方針）。
    if (sig.hasUnfinishedCycle) {
      return {
        ...common,
        action: 'skip' as const,
        reason: 'previous auto-improve cycle for this project is still open',
      };
    }

    const drift = detectOracleDrift(mat.oracleDrift);
    const driftNote = drift.drifting ? `; ⚠ oracle-drift (${drift.level}): ${drift.reason}` : '';
    return {
      ...common,
      action: 'draft' as const,
      reason: sig.plateauReason
        ? `default draft policy (order-first); ${sig.plateauReason}${phase.phase === 'converge' ? '; converge phase (deadline near)' : ''}${driftNote}`
        : `default draft policy (order-first): only duplicate-prevention guard applies${phase.phase === 'converge' ? '; converge phase (deadline near)' : ''}${driftNote}`,
      issueTitle: buildIssueTitle(t, t.nextCycle),
      issueBody: buildIssueBody(t, competition, t.nextCycle, mat, phase),
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
