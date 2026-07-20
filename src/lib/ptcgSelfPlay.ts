import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SELF_PLAY_JOB_SCHEMA = 'ptcg-self-play-job/v1' as const;
export const SELF_PLAY_CHECKPOINT_SCHEMA = 'ptcg-self-play-checkpoint/v1' as const;
export const SELF_PLAY_ARTIFACT_SCHEMA = 'ptcg-self-play-artifact/v1' as const;

export type WorkerMode = 'local' | 'distributed';

export interface SelfPlayJob {
  schemaVersion: typeof SELF_PLAY_JOB_SCHEMA;
  runId: string;
  seed: number;
  matches: number;
  contestants: { first: string; second: string };
  versions: { engine: string; environment: string };
}

export interface SelfPlayMatch {
  matchId: string;
  runId: string;
  index: number;
  seed: number;
  result: unknown;
  artifact: SelfPlayArtifactMetadata;
}

export interface SelfPlayArtifactMetadata {
  schemaVersion: typeof SELF_PLAY_ARTIFACT_SCHEMA;
  runId: string;
  matchId: string;
  parentArtifactId: string | null;
  artifactId: string;
}

export interface SelfPlayCheckpoint {
  schemaVersion: typeof SELF_PLAY_CHECKPOINT_SCHEMA;
  job: SelfPlayJob;
  completed: SelfPlayMatch[];
}

export interface EnvironmentWorker {
  mode: WorkerMode;
  // eslint-disable-next-line no-unused-vars
  play(_input: {
    job: SelfPlayJob;
    matchId: string;
    matchIndex: number;
    seed: number;
  }): Promise<{ result: unknown; artifactId?: string; parentArtifactId?: string | null }>;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function stableHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Derive a portable uint32 seed without relying on process-specific RNG state. */
export function deriveMatchSeed(runSeed: number, matchIndex: number): number {
  if (!Number.isSafeInteger(runSeed) || runSeed < 0)
    throw new Error('run seed must be non-negative');
  if (!Number.isSafeInteger(matchIndex) || matchIndex < 0)
    throw new Error('match index must be non-negative');
  return Number.parseInt(stableHash(`${runSeed}:${matchIndex}`).slice(0, 8), 16);
}

export function matchIdFor(runId: string, matchIndex: number): string {
  if (!ID_RE.test(runId)) throw new Error('runId must be a stable lowercase id');
  if (!Number.isSafeInteger(matchIndex) || matchIndex < 0)
    throw new Error('match index must be non-negative');
  return `${runId}.match.${String(matchIndex).padStart(8, '0')}`;
}

export function validateSelfPlayJob(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['job must be an object'];
  const job = value as Partial<SelfPlayJob>;
  if (job.schemaVersion !== SELF_PLAY_JOB_SCHEMA)
    errors.push(`schemaVersion must be ${SELF_PLAY_JOB_SCHEMA}`);
  if (typeof job.runId !== 'string' || !ID_RE.test(job.runId))
    errors.push('runId must be a stable lowercase id');
  if (!Number.isSafeInteger(job.seed) || Number(job.seed) < 0)
    errors.push('seed must be a non-negative safe integer');
  if (!Number.isSafeInteger(job.matches) || Number(job.matches) < 1)
    errors.push('matches must be a positive safe integer');
  if (!job.contestants || !ID_RE.test(job.contestants.first) || !ID_RE.test(job.contestants.second))
    errors.push('contestants must contain stable first and second ids');
  if (job.contestants?.first === job.contestants?.second) errors.push('contestants must differ');
  if (!job.versions?.engine || !job.versions?.environment)
    errors.push('engine and environment versions are required');
  return errors;
}

export function createCheckpoint(job: SelfPlayJob): SelfPlayCheckpoint {
  const errors = validateSelfPlayJob(job);
  if (errors.length) throw new Error(errors.join('; '));
  return { schemaVersion: SELF_PLAY_CHECKPOINT_SCHEMA, job: structuredClone(job), completed: [] };
}

export function validateCheckpoint(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return ['checkpoint must be an object'];
  const checkpoint = value as Partial<SelfPlayCheckpoint>;
  if (checkpoint.schemaVersion !== SELF_PLAY_CHECKPOINT_SCHEMA)
    errors.push(`schemaVersion must be ${SELF_PLAY_CHECKPOINT_SCHEMA}`);
  const jobErrors = validateSelfPlayJob(checkpoint.job);
  errors.push(...jobErrors.map((error) => `job.${error}`));
  if (!Array.isArray(checkpoint.completed)) return [...errors, 'completed must be an array'];
  if (jobErrors.length) return errors;
  const job = checkpoint.job as SelfPlayJob;
  const seen = new Set<string>();
  checkpoint.completed.forEach((value, position) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`completed[${position}] must be an object`);
      return;
    }
    const match = value as SelfPlayMatch;
    if (!Number.isSafeInteger(match.index) || match.index < 0) {
      errors.push(`completed[${position}].index must be non-negative`);
      return;
    }
    const expectedId = matchIdFor(job.runId, match.index);
    if (match.runId !== job.runId) errors.push(`completed[${position}].runId mismatch`);
    if (match.matchId !== expectedId) errors.push(`completed[${position}].matchId mismatch`);
    if (match.seed !== deriveMatchSeed(job.seed, match.index))
      errors.push(`completed[${position}].seed mismatch`);
    if (match.index >= job.matches) errors.push(`completed[${position}].index out of range`);
    if (seen.has(match.matchId))
      errors.push(`completed[${position}].matchId duplicates ${match.matchId}`);
    seen.add(match.matchId);
    if (
      match.artifact?.schemaVersion !== SELF_PLAY_ARTIFACT_SCHEMA ||
      match.artifact.runId !== match.runId ||
      match.artifact.matchId !== match.matchId ||
      !match.artifact.artifactId
    )
      errors.push(`completed[${position}].artifact lineage is invalid`);
  });
  return errors;
}

export function loadCheckpoint(file: string, expectedJob?: SelfPlayJob): SelfPlayCheckpoint {
  const checkpoint = JSON.parse(fs.readFileSync(file, 'utf8')) as SelfPlayCheckpoint;
  const errors = validateCheckpoint(checkpoint);
  if (errors.length) throw new Error(errors.join('; '));
  if (
    expectedJob &&
    stableHash(JSON.stringify(checkpoint.job)) !== stableHash(JSON.stringify(expectedJob))
  )
    throw new Error('checkpoint job does not match requested job');
  return checkpoint;
}

/** Write-rename keeps a crash from leaving a partially written checkpoint. */
export function saveCheckpoint(file: string, checkpoint: SelfPlayCheckpoint): void {
  const errors = validateCheckpoint(checkpoint);
  if (errors.length) throw new Error(errors.join('; '));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export class MatchManager {
  private readonly completed = new Map<string, SelfPlayMatch>();

  constructor(
    readonly job: SelfPlayJob,
    checkpoint: SelfPlayCheckpoint = createCheckpoint(job)
  ) {
    const errors = validateCheckpoint(checkpoint);
    if (errors.length) throw new Error(errors.join('; '));
    if (stableHash(JSON.stringify(job)) !== stableHash(JSON.stringify(checkpoint.job)))
      throw new Error('checkpoint job does not match manager job');
    checkpoint.completed.forEach((match) =>
      this.completed.set(match.matchId, structuredClone(match))
    );
  }

  pendingIndexes(): number[] {
    return Array.from({ length: this.job.matches }, (_, index) => index).filter(
      (index) => !this.completed.has(matchIdFor(this.job.runId, index))
    );
  }

  /** Registration is idempotent for identical results and rejects conflicting replays. */
  register(match: SelfPlayMatch): boolean {
    const candidate: SelfPlayCheckpoint = { ...this.checkpoint(), completed: [match] };
    const errors = validateCheckpoint(candidate);
    if (errors.length) throw new Error(errors.join('; '));
    const existing = this.completed.get(match.matchId);
    if (existing) {
      if (stableHash(JSON.stringify(existing)) !== stableHash(JSON.stringify(match)))
        throw new Error(`conflicting result for completed match ${match.matchId}`);
      return false;
    }
    this.completed.set(match.matchId, structuredClone(match));
    return true;
  }

  checkpoint(): SelfPlayCheckpoint {
    return {
      schemaVersion: SELF_PLAY_CHECKPOINT_SCHEMA,
      job: structuredClone(this.job),
      completed: [...this.completed.values()].sort((a, b) => a.index - b.index),
    };
  }

  async run(
    worker: EnvironmentWorker,
    // eslint-disable-next-line no-unused-vars
    onCheckpoint?: (_value: SelfPlayCheckpoint) => void
  ): Promise<SelfPlayCheckpoint> {
    for (const index of this.pendingIndexes()) {
      const matchId = matchIdFor(this.job.runId, index);
      const seed = deriveMatchSeed(this.job.seed, index);
      const output = await worker.play({
        job: structuredClone(this.job),
        matchId,
        matchIndex: index,
        seed,
      });
      this.register({
        matchId,
        runId: this.job.runId,
        index,
        seed,
        result: output.result,
        artifact: {
          schemaVersion: SELF_PLAY_ARTIFACT_SCHEMA,
          runId: this.job.runId,
          matchId,
          parentArtifactId: output.parentArtifactId ?? null,
          artifactId: output.artifactId ?? `${matchId}.result`,
        },
      });
      onCheckpoint?.(this.checkpoint());
    }
    return this.checkpoint();
  }
}
