import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ARC_AGI_3_EVALUATION_SCHEMA = 'arc-agi-3-evaluation/v1' as const;
export const ARC_AGI_3_CHAMPION_SCHEMA = 'arc-agi-3-champion-registry/v1' as const;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ArcAgi3Reset<Observation> {
  observation: Observation;
  info?: Record<string, JsonValue>;
}

export interface ArcAgi3Step<Observation> {
  observation: Observation;
  reward: number;
  terminated: boolean;
  info?: Record<string, JsonValue>;
}

/** Minimal adapter boundary. Implementations must derive all randomness from reset(seed). */
export interface ArcAgi3Environment<Action, Observation> {
  readonly environmentId: string;
  readonly environmentVersion: string;
  reset(seed: number): Promise<ArcAgi3Reset<Observation>> | ArcAgi3Reset<Observation>;
  step(action: Action): Promise<ArcAgi3Step<Observation>> | ArcAgi3Step<Observation>;
}

export interface ArcAgi3Agent<Action, Observation> {
  readonly candidateId: string;
  readonly artifactId: string;
  act(
    input: Readonly<{
      observation: Observation;
      seed: number;
      step: number;
    }>
  ): Promise<Action> | Action;
}

export type EpisodeEnd = 'terminated' | 'step_limit';

export interface ArcAgi3Episode {
  seed: number;
  score: number;
  steps: number;
  end: EpisodeEnd;
  trajectoryHash: string;
}

export interface EvaluationStage {
  name: 'screen' | 'confirm';
  seeds: number[];
  episodes: ArcAgi3Episode[];
  meanScore: number;
}

export interface ArcAgi3Evaluation {
  schemaVersion: typeof ARC_AGI_3_EVALUATION_SCHEMA;
  runId: string;
  candidate: { id: string; artifactId: string };
  environment: { id: string; version: string };
  maxSteps: number;
  stages: EvaluationStage[];
  gate: {
    screenMinimumMean: number;
    screenPassed: boolean;
    confirmExecuted: boolean;
  };
  fingerprint: string;
}

export interface ArcAgi3EvaluationPlan {
  runId: string;
  screenSeeds: number[];
  confirmSeeds: number[];
  maxSteps: number;
  screenMinimumMean: number;
}

export interface ChampionRegistry {
  schemaVersion: typeof ARC_AGI_3_CHAMPION_SCHEMA;
  environment: { id: string; version: string };
  champion: null | {
    candidateId: string;
    artifactId: string;
    evaluationFingerprint: string;
    promotedAt: string;
  };
}

function assertSeeds(name: string, seeds: readonly number[]): void {
  if (!seeds.length) throw new Error(`${name} must not be empty`);
  if (new Set(seeds).size !== seeds.length) throw new Error(`${name} must be unique`);
  if (seeds.some((seed) => !Number.isSafeInteger(seed) || seed < 0))
    throw new Error(`${name} must contain non-negative safe integers`);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function assertJson(value: unknown, label: string): asserts value is JsonValue {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error();
    JSON.parse(encoded);
  } catch {
    throw new Error(`${label} must be JSON-serializable`);
  }
}

export async function runArcAgi3Episode<Action, Observation>(
  environment: ArcAgi3Environment<Action, Observation>,
  agent: ArcAgi3Agent<Action, Observation>,
  seed: number,
  maxSteps: number
): Promise<ArcAgi3Episode> {
  if (!Number.isSafeInteger(seed) || seed < 0)
    throw new Error('seed must be a non-negative safe integer');
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error('maxSteps must be positive');
  const reset = await environment.reset(seed);
  assertJson(reset.observation, 'observation');
  let observation = reset.observation;
  let score = 0;
  const trajectory: unknown[] = [{ observation, info: reset.info ?? {} }];
  for (let step = 0; step < maxSteps; step += 1) {
    const action = await agent.act({ observation, seed, step });
    assertJson(action, 'action');
    const result = await environment.step(action);
    assertJson(result.observation, 'observation');
    if (!Number.isFinite(result.reward)) throw new Error('reward must be finite');
    score += result.reward;
    trajectory.push({ action, ...result, info: result.info ?? {} });
    observation = result.observation;
    if (result.terminated) {
      return {
        seed,
        score,
        steps: step + 1,
        end: 'terminated',
        trajectoryHash: sha256(trajectory),
      };
    }
  }
  return { seed, score, steps: maxSteps, end: 'step_limit', trajectoryHash: sha256(trajectory) };
}

async function runStage<Action, Observation>(
  name: EvaluationStage['name'],
  seeds: number[],
  createEnvironment: () => ArcAgi3Environment<Action, Observation>,
  agent: ArcAgi3Agent<Action, Observation>,
  maxSteps: number
): Promise<EvaluationStage> {
  const episodes: ArcAgi3Episode[] = [];
  for (const seed of seeds)
    episodes.push(await runArcAgi3Episode(createEnvironment(), agent, seed, maxSteps));
  return {
    name,
    seeds: [...seeds],
    episodes,
    meanScore: episodes.reduce((sum, episode) => sum + episode.score, 0) / episodes.length,
  };
}

/** Screen and confirm use disjoint seeds and preserve one candidate identity across both stages. */
export async function evaluateArcAgi3Candidate<Action, Observation>(
  plan: ArcAgi3EvaluationPlan,
  createEnvironment: () => ArcAgi3Environment<Action, Observation>,
  agent: ArcAgi3Agent<Action, Observation>
): Promise<ArcAgi3Evaluation> {
  if (!plan.runId.trim()) throw new Error('runId is required');
  assertSeeds('screenSeeds', plan.screenSeeds);
  assertSeeds('confirmSeeds', plan.confirmSeeds);
  if (plan.screenSeeds.some((seed) => plan.confirmSeeds.includes(seed)))
    throw new Error('screenSeeds and confirmSeeds must be disjoint');
  if (!Number.isFinite(plan.screenMinimumMean)) throw new Error('screenMinimumMean must be finite');
  const probe = createEnvironment();
  if (!probe.environmentId.trim() || !probe.environmentVersion.trim())
    throw new Error('environment id and version are required');
  if (!agent.candidateId.trim() || !agent.artifactId.trim())
    throw new Error('candidate id and artifact id are required');

  const screen = await runStage(
    'screen',
    plan.screenSeeds,
    createEnvironment,
    agent,
    plan.maxSteps
  );
  const screenPassed = screen.meanScore >= plan.screenMinimumMean;
  const stages = [screen];
  if (screenPassed)
    stages.push(
      await runStage('confirm', plan.confirmSeeds, createEnvironment, agent, plan.maxSteps)
    );
  const withoutFingerprint = {
    schemaVersion: ARC_AGI_3_EVALUATION_SCHEMA,
    runId: plan.runId,
    candidate: { id: agent.candidateId, artifactId: agent.artifactId },
    environment: { id: probe.environmentId, version: probe.environmentVersion },
    maxSteps: plan.maxSteps,
    stages,
    gate: {
      screenMinimumMean: plan.screenMinimumMean,
      screenPassed,
      confirmExecuted: screenPassed,
    },
  };
  return { ...withoutFingerprint, fingerprint: sha256(withoutFingerprint) };
}

export function createChampionRegistry(
  evaluation: Pick<ArcAgi3Evaluation, 'environment'>,
  champion: ChampionRegistry['champion'] = null
): ChampionRegistry {
  return {
    schemaVersion: ARC_AGI_3_CHAMPION_SCHEMA,
    environment: { ...evaluation.environment },
    champion,
  };
}

export function promoteChampion(
  registry: ChampionRegistry,
  evaluation: ArcAgi3Evaluation,
  promotedAt: string
): ChampionRegistry {
  if (!evaluation.gate.confirmExecuted)
    throw new Error('candidate must complete confirm before promotion');
  if (
    registry.environment.id !== evaluation.environment.id ||
    registry.environment.version !== evaluation.environment.version
  )
    throw new Error('registry environment does not match evaluation');
  if (Number.isNaN(Date.parse(promotedAt))) throw new Error('promotedAt must be ISO-8601');
  return {
    ...registry,
    champion: {
      candidateId: evaluation.candidate.id,
      artifactId: evaluation.candidate.artifactId,
      evaluationFingerprint: evaluation.fingerprint,
      promotedAt,
    },
  };
}

export function writeEvaluationArtifact(file: string, evaluation: ArcAgi3Evaluation): void {
  writeJsonAtomically(file, evaluation);
}

export function writeChampionRegistry(file: string, registry: ChampionRegistry): void {
  writeJsonAtomically(file, registry);
}

function writeJsonAtomically(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}
