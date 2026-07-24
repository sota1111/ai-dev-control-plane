/**
 * SOT-1904 — Kaggle 自動提出の優先度選定ロジック（pure functions, no I/O）。
 *
 * コンペ `pokemon-tcg-ai-battle` の最終評価は **直近2提出のみ** が反映される（+ 1日5提出上限）。
 * 「最終2枠に載せたい agent」を優先度付きで registry（config/kaggle_submission_registry.json）に登録し、
 * スケジューラ（AM0/4/8・PM4/8 JST の5枠）が起動するたびに、
 *   (1) 前回までの提出結果（直近提出 agent・当日の提出数）を確認し、
 *   (2) 「直近2提出＝最上位2 agent」に収束するよう、優先度に従って次に提出すべき1 agent を選ぶ。
 *
 * ここは純粋関数のみ（Kaggle CLI やファイル I/O は scripts/ai/kaggle_auto_submit.sh 側）なので単体テスト可能。
 * 選定の詳細な運用ゲート（収束判定・ノイズ幅・league KPI）は docs/ai/kaggle-final-submission-gate.md、
 * 自動提出そのものの契約は docs/kaggle-submission.md を参照。
 */

/** どうやって実際に提出するか（`--execute` 時に scripts/ai/kaggle_auto_submit.sh が読む）。 */
export interface AgentSubmitSpec {
  /** `kaggle competitions submit -f <file>` に渡す提出物のパス（未設定なら execute はスキップ）。 */
  file?: string;
  /** 提出メッセージ（`-m`）。未設定なら既定メッセージを使う。 */
  message?: string;
}

/** registry に登録された1 agent。 */
export interface SubmissionAgent {
  /** agent 名（Kaggle 提出の description 中の `ptcg-agent-<name>` と一致させる）。 */
  name: string;
  /** 優先度（1 = 最上位）。最終2枠は enabled 中の優先度上位2。 */
  priority: number;
  /** 自動提出ローテーションの対象か。false の agent は計測目的で自動提出しない。 */
  enabled: boolean;
  /** agent の GitHub repo（提出物のビルド元。任意）。 */
  repo?: string;
  /** 補足メモ（任意）。 */
  note?: string;
  /** 実提出の指定（任意）。 */
  submit?: AgentSubmitSpec;
}

/** 自動提出 registry（config/kaggle_submission_registry.json をパースした形）。 */
export interface SubmissionRegistry {
  competition: string;
  /** Kaggle の1日提出上限（既定 5）。 */
  dailySubmissionCap: number;
  /** 自動提出を起動する時刻（JST の hour, 0-23）。既定 [0,4,8,16,20]。 */
  scheduleHoursJst: number[];
  agents: SubmissionAgent[];
}

/** Kaggle から取得した提出履歴の1件（新しい順に渡す）。 */
export interface RecentSubmission {
  agent: string;
  ref?: string;
  score?: number | null;
  status?: string;
}

/** planSubmission の入力。 */
export interface PlanInput {
  registry: SubmissionRegistry;
  /** 提出履歴（**新しい順**）。COMPLETE / pending 問わず、agent 名が判るものを渡す。 */
  recent: RecentSubmission[];
  /** 当日（Kaggle の提出上限リセット単位）に既に出した提出数。 */
  submittedToday: number;
}

/** planSubmission の出力（そのまま JSON 化して bash へ渡せる）。 */
export interface SubmissionPlan {
  competition: string;
  cap: number;
  submittedToday: number;
  remainingToday: number;
  /** 最終2枠の目標（enabled 中の優先度上位2）。 */
  target: string[];
  /** 現在アクティブな最終2枠（直近2提出の agent）。 */
  currentLastTwo: string[];
  /** 今回提出すべき agent（null = スキップ）。 */
  selected: string | null;
  /** 判断理由（人間可読）。 */
  reason: string;
}

const VALID_HOUR = (h: unknown): h is number =>
  typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23;

/**
 * config/kaggle_submission_registry.json の生 JSON を検証済みの SubmissionRegistry にする。
 * `__` で始まるキー（ドキュメント）は無視する。不正な形は Error を投げる（fail-loud）。
 */
export function parseRegistry(raw: unknown): SubmissionRegistry {
  if (!raw || typeof raw !== 'object') {
    throw new Error('registry must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const competition = obj.competition;
  if (typeof competition !== 'string' || !competition) {
    throw new Error('registry.competition must be a non-empty string');
  }

  const cap = obj.daily_submission_cap ?? obj.dailySubmissionCap ?? 5;
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap <= 0) {
    throw new Error('registry.daily_submission_cap must be a positive integer');
  }

  const hoursRaw = obj.schedule_hours_jst ?? obj.scheduleHoursJst ?? [0, 4, 8, 16, 20];
  if (!Array.isArray(hoursRaw) || hoursRaw.length === 0 || !hoursRaw.every(VALID_HOUR)) {
    throw new Error('registry.schedule_hours_jst must be a non-empty array of hours (0-23)');
  }
  // 重複除去・昇順で正規化。
  const scheduleHoursJst = Array.from(new Set(hoursRaw as number[])).sort((a, b) => a - b);

  const agentsRaw = obj.agents;
  if (!Array.isArray(agentsRaw) || agentsRaw.length === 0) {
    throw new Error('registry.agents must be a non-empty array');
  }

  const seen = new Set<string>();
  const agents: SubmissionAgent[] = agentsRaw.map((a, i) => {
    if (!a || typeof a !== 'object') {
      throw new Error(`registry.agents[${i}] must be an object`);
    }
    const ao = a as Record<string, unknown>;
    const name = ao.name;
    if (typeof name !== 'string' || !name) {
      throw new Error(`registry.agents[${i}].name must be a non-empty string`);
    }
    if (seen.has(name)) {
      throw new Error(`registry.agents[${i}].name "${name}" is duplicated`);
    }
    seen.add(name);
    const priority = ao.priority;
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority <= 0) {
      throw new Error(`registry.agents[${i}].priority must be a positive integer`);
    }
    const enabled = ao.enabled;
    if (typeof enabled !== 'boolean') {
      throw new Error(`registry.agents[${i}].enabled must be a boolean`);
    }
    const agent: SubmissionAgent = { name, priority, enabled };
    if (typeof ao.repo === 'string') agent.repo = ao.repo;
    if (typeof ao.note === 'string') agent.note = ao.note;
    if (ao.submit && typeof ao.submit === 'object') {
      const so = ao.submit as Record<string, unknown>;
      const spec: AgentSubmitSpec = {};
      if (typeof so.file === 'string') spec.file = so.file;
      if (typeof so.message === 'string') spec.message = so.message;
      agent.submit = spec;
    }
    return agent;
  });

  return { competition, dailySubmissionCap: cap, scheduleHoursJst, agents };
}

/** enabled な agent を優先度昇順（1=最上位）で返す。同順位は name で安定ソート。 */
export function enabledByPriority(registry: SubmissionRegistry): SubmissionAgent[] {
  return registry.agents
    .filter((a) => a.enabled)
    .slice()
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
}

/** 最終2枠の目標＝enabled 中の優先度上位2 agent 名。 */
export function finalTwoTargets(registry: SubmissionRegistry): string[] {
  return enabledByPriority(registry)
    .slice(0, 2)
    .map((a) => a.name);
}

/** 指定 hour(JST) が自動提出スケジュールの枠かどうか。 */
export function isScheduledHour(registry: SubmissionRegistry, hourJst: number): boolean {
  return registry.scheduleHoursJst.includes(hourJst);
}

/**
 * 今回提出すべき1 agent を選ぶ。
 *
 * 方針: 「直近2提出＝最上位2 agent（target）」に最短で収束させる。
 *  - 当日の提出上限に達していれば何も出さない（selected=null）。
 *  - それ以外は enabled の中から、
 *      (a) target のうち現在の直近2枠から欠けている agent を最優先、
 *      (b) いなければ target を交互提出して最新2枠を維持（＝直近1件と同じ agent は避ける）、
 *    の順で **最優先の1 agent** を選ぶ。
 *  これにより通常はローテーションで target を最新2枠に保ち、計測提出で押し出された場合も
 *  数枠内で target を復元する。
 */
export function planSubmission(input: PlanInput): SubmissionPlan {
  const { registry, recent, submittedToday } = input;
  const cap = registry.dailySubmissionCap;
  const remainingToday = Math.max(0, cap - submittedToday);
  const target = finalTwoTargets(registry);
  const currentLastTwo = recent.slice(0, 2).map((r) => r.agent);

  const base: Omit<SubmissionPlan, 'selected' | 'reason'> = {
    competition: registry.competition,
    cap,
    submittedToday,
    remainingToday,
    target,
    currentLastTwo,
  };

  if (remainingToday <= 0) {
    return { ...base, selected: null, reason: `daily cap reached (${submittedToday}/${cap})` };
  }

  const enabled = enabledByPriority(registry);
  if (enabled.length === 0) {
    return { ...base, selected: null, reason: 'no enabled agents in registry' };
  }

  const mostRecent = recent[0]?.agent;
  // 直近1件と同じ agent を再提出しても最新枠が変わらないので候補から外す（他に候補がある場合のみ）。
  let candidates = enabled.filter((a) => a.name !== mostRecent);
  if (candidates.length === 0) candidates = enabled;

  // target のうち現在の直近2枠に無いものを最優先で埋める。
  const missingTargets = target.filter((t) => !currentLastTwo.includes(t));
  const missingCandidates = candidates.filter((a) => missingTargets.includes(a.name));
  const pool = missingCandidates.length > 0 ? missingCandidates : candidates;

  const selected = pool[0].name; // pool は enabled 由来で優先度昇順を維持
  const reason =
    missingCandidates.length > 0
      ? `restore/maintain final-2: "${selected}" is a target agent missing from the last-2 [${currentLastTwo.join(', ')}]`
      : `rotate final-2: submit next-highest-priority "${selected}" to keep the top-2 [${target.join(', ')}] as the last-2`;

  return { ...base, selected, reason };
}
