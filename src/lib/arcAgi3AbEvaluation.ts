import fs from 'node:fs';
import path from 'node:path';

/** SOT-2191 — deterministic four-condition ARC-AGI-3 evaluation contracts. */
export const ARC_AB_CONDITIONS = [
  'baseline',
  'retained_reasoning',
  'compaction',
  'retained_reasoning_and_compaction',
] as const;

export type ArcAbCondition = (typeof ARC_AB_CONDITIONS)[number];

export interface ArcAbEvaluationConfig {
  gameIds: string[];
  actionBudget: number;
  trialsPerGame: number;
  seed: number;
  guardrails: {
    maxTotalTokensRatio: number;
    maxApiCostRatio: number;
    maxLatencyRatio: number;
  };
}

export interface ArcAbRun {
  runId: string;
  condition: ArcAbCondition;
  gameId: string;
  trial: number;
  seed: number;
  actionBudget: number;
  retainedReasoning: boolean;
  compaction: boolean;
  /** Unique per condition/game/trial; response ids must not cross this boundary. */
  responseChainKey: string;
}

export interface ArcAbTelemetry {
  condition: ArcAbCondition;
  gameId: string;
  trial: number;
  score: number;
  levelCompletion: number;
  actions: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  durationMs: number;
  apiCostUsd: number;
}

export interface ArcAbArtifact {
  schemaVersion: 1;
  issueId: string;
  createdAt: string;
  config: ArcAbEvaluationConfig;
  runs: ArcAbRun[];
  telemetry: ArcAbTelemetry[];
}

export interface ArcAbKpis {
  score: number;
  levelCompletion: number;
  actions: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  durationMs: number;
  apiCostUsd: number;
}

export interface ChampionPromotionDecision {
  promote: boolean;
  championCondition: ArcAbCondition;
  previousChampionCondition: 'baseline';
  reason: string;
  kpis?: Record<ArcAbCondition, ArcAbKpis>;
}

export interface ArcAbChampionSettings {
  schemaVersion: 1;
  condition: ArcAbCondition;
  sourceIssueId: string;
  artifactPath: string;
  promotedAt: string;
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

export function validateArcAbConfig(config: ArcAbEvaluationConfig): void {
  if (!Array.isArray(config.gameIds) || config.gameIds.length === 0) {
    throw new Error('gameIds must be a non-empty array');
  }
  const games = config.gameIds.map((game) => game.trim());
  if (games.some((game) => !game) || new Set(games).size !== games.length) {
    throw new Error('gameIds must contain unique non-empty values');
  }
  positiveInteger('actionBudget', config.actionBudget);
  positiveInteger('trialsPerGame', config.trialsPerGame);
  if (!Number.isInteger(config.seed)) throw new Error('seed must be an integer');
  for (const [name, value] of Object.entries(config.guardrails)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  }
}

/** All conditions receive the same games, action budget, trial count, and seeds. */
export function buildArcAbEvaluationPlan(
  issueId: string,
  config: ArcAbEvaluationConfig
): ArcAbRun[] {
  validateArcAbConfig(config);
  if (!issueId.trim()) throw new Error('issueId must be non-empty');
  return ARC_AB_CONDITIONS.flatMap((condition) =>
    config.gameIds.flatMap((gameId) =>
      Array.from({ length: config.trialsPerGame }, (_, index): ArcAbRun => {
        const trial = index + 1;
        const identity = `${issueId}:${condition}:${gameId}:${trial}`;
        return {
          runId: identity,
          condition,
          gameId,
          trial,
          seed: config.seed + index,
          actionBudget: config.actionBudget,
          retainedReasoning:
            condition === 'retained_reasoning' || condition === 'retained_reasoning_and_compaction',
          compaction:
            condition === 'compaction' || condition === 'retained_reasoning_and_compaction',
          responseChainKey: identity,
        };
      })
    )
  );
}

const NUMERIC_FIELDS: Array<keyof Omit<ArcAbTelemetry, 'condition' | 'gameId'>> = [
  'trial',
  'score',
  'levelCompletion',
  'actions',
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'durationMs',
  'apiCostUsd',
];
const telemetryKey = (row: Pick<ArcAbTelemetry, 'condition' | 'gameId' | 'trial'>): string =>
  `${row.condition}:${row.gameId}:${row.trial}`;

/** Fail-closed validation: every planned run needs exactly one complete KPI row. */
export function validateArcAbArtifact(artifact: ArcAbArtifact): string[] {
  const errors: string[] = [];
  try {
    validateArcAbConfig(artifact.config);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (artifact.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!artifact.issueId?.trim()) errors.push('issueId is required');
  if (!artifact.createdAt || Number.isNaN(Date.parse(artifact.createdAt))) {
    errors.push('createdAt must be an ISO timestamp');
  }
  const expected = new Set(artifact.runs.map(telemetryKey));
  const seen = new Set<string>();
  for (const row of artifact.telemetry) {
    const key = telemetryKey(row);
    if (!expected.has(key)) errors.push(`unexpected telemetry row: ${key}`);
    if (seen.has(key)) errors.push(`duplicate telemetry row: ${key}`);
    seen.add(key);
    for (const field of NUMERIC_FIELDS) {
      if (!Number.isFinite(row[field])) errors.push(`missing or invalid ${field}: ${key}`);
    }
  }
  for (const key of expected) {
    if (!seen.has(key)) errors.push(`missing telemetry row: ${key}`);
  }
  return errors;
}

function aggregate(rows: ArcAbTelemetry[]): ArcAbKpis {
  const sum = (field: keyof ArcAbTelemetry): number =>
    rows.reduce((total, row) => total + Number(row[field]), 0);
  const inputTokens = sum('inputTokens');
  const outputTokens = sum('outputTokens');
  const reasoningTokens = sum('reasoningTokens');
  return {
    score: sum('score') / rows.length,
    levelCompletion: sum('levelCompletion') / rows.length,
    actions: sum('actions') / rows.length,
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens + reasoningTokens,
    durationMs: sum('durationMs'),
    apiCostUsd: sum('apiCostUsd'),
  };
}

const withinRatio = (candidate: number, baseline: number, maximum: number): boolean =>
  baseline === 0 ? candidate === 0 : candidate / baseline <= maximum;

/** Score is primary; completion and resource KPIs are mandatory guardrails. */
export function decideArcAbChampionPromotion(artifact: ArcAbArtifact): ChampionPromotionDecision {
  const errors = validateArcAbArtifact(artifact);
  if (errors.length > 0) {
    return {
      promote: false,
      championCondition: 'baseline',
      previousChampionCondition: 'baseline',
      reason: `incomplete artifact: ${errors.join('; ')}`,
    };
  }
  const kpis = Object.fromEntries(
    ARC_AB_CONDITIONS.map((condition) => [
      condition,
      aggregate(artifact.telemetry.filter((row) => row.condition === condition)),
    ])
  ) as Record<ArcAbCondition, ArcAbKpis>;
  const baseline = kpis.baseline;
  const eligible = ARC_AB_CONDITIONS.filter((condition) => condition !== 'baseline')
    .filter((condition) => {
      const candidate = kpis[condition];
      return (
        candidate.score > baseline.score &&
        candidate.levelCompletion >= baseline.levelCompletion &&
        withinRatio(
          candidate.totalTokens,
          baseline.totalTokens,
          artifact.config.guardrails.maxTotalTokensRatio
        ) &&
        withinRatio(
          candidate.apiCostUsd,
          baseline.apiCostUsd,
          artifact.config.guardrails.maxApiCostRatio
        ) &&
        withinRatio(
          candidate.durationMs,
          baseline.durationMs,
          artifact.config.guardrails.maxLatencyRatio
        )
      );
    })
    .sort((a, b) => kpis[b].score - kpis[a].score);
  const winner = eligible[0];
  if (!winner) {
    return {
      promote: false,
      championCondition: 'baseline',
      previousChampionCondition: 'baseline',
      reason: 'no candidate improved score while passing completion and resource guardrails',
      kpis,
    };
  }
  return {
    promote: true,
    championCondition: winner,
    previousChampionCondition: 'baseline',
    reason: `${winner} has the highest eligible score`,
    kpis,
  };
}

function writeJsonAtomically(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

/** Persist the complete KPI artifact consumed by the promotion gate. */
export function writeArcAbArtifact(file: string, artifact: ArcAbArtifact): void {
  const errors = validateArcAbArtifact(artifact);
  if (errors.length > 0) throw new Error(`cannot write incomplete artifact: ${errors.join('; ')}`);
  writeJsonAtomically(file, artifact);
}

/** Update settings only after a passing decision; rejected candidates preserve the incumbent. */
export function promoteArcAbChampion(
  incumbent: ArcAbChampionSettings,
  artifact: ArcAbArtifact,
  artifactPath: string,
  promotedAt: string
): ArcAbChampionSettings {
  const decision = decideArcAbChampionPromotion(artifact);
  if (!decision.promote) return incumbent;
  if (!artifactPath.trim()) throw new Error('artifactPath must be non-empty');
  if (!promotedAt || Number.isNaN(Date.parse(promotedAt))) {
    throw new Error('promotedAt must be an ISO timestamp');
  }
  return {
    schemaVersion: 1,
    condition: decision.championCondition,
    sourceIssueId: artifact.issueId,
    artifactPath,
    promotedAt,
  };
}

export function writeArcAbChampionSettings(file: string, settings: ArcAbChampionSettings): void {
  writeJsonAtomically(file, settings);
}

export interface NextImprovementIssuePlan {
  action: 'create' | 'skip';
  idempotencyKey: string;
  reason: string;
}

/** Plan automatic Linear continuation once per completed evaluation. */
export function planNextImprovementIssue(
  project: string,
  completedIssueId: string,
  nextCycle: number,
  existingIdempotencyKeys: readonly string[]
): NextImprovementIssuePlan {
  if (!project.trim() || !completedIssueId.trim()) {
    throw new Error('project and completedIssueId must be non-empty');
  }
  positiveInteger('nextCycle', nextCycle);
  const idempotencyKey = `kaggle-improve:${project}:${completedIssueId}:cycle-${nextCycle}`;
  return existingIdempotencyKeys.includes(idempotencyKey)
    ? { action: 'skip', idempotencyKey, reason: 'continuation issue already exists' }
    : {
        action: 'create',
        idempotencyKey,
        reason: 'create the next improvement issue automatically',
      };
}
