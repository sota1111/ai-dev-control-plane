import crypto from 'node:crypto';

import type { SelfPlayJob } from './ptcgSelfPlay.js';

export type SelfPlayFailureKind = 'retryable' | 'permanent';
export type SelfPlayJobState = 'queued' | 'running' | 'completed' | 'failed';
export type SelfPlayAttemptState =
  | 'running'
  | 'completed'
  | 'retryable_failure'
  | 'permanent_failure'
  | 'timed_out';

export interface SelfPlayAttemptArtifact {
  artifactId: string;
  kind: string;
  uri: string;
}

export interface SelfPlayAttempt {
  attempt: number;
  workerId: string;
  leaseToken: string;
  startedAt: number;
  heartbeatAt: number;
  finishedAt: number | null;
  state: SelfPlayAttemptState;
  failureReason: string | null;
  artifacts: SelfPlayAttemptArtifact[];
}

export interface LeasedSelfPlayJob {
  job: SelfPlayJob;
  state: SelfPlayJobState;
  maxAttempts: number;
  nextEligibleAt: number;
  lease: { workerId: string; token: string; expiresAt: number } | null;
  attempts: SelfPlayAttempt[];
}

export interface JobLease {
  job: SelfPlayJob;
  attempt: number;
  workerId: string;
  token: string;
  expiresAt: number;
}

export interface FailureClassification {
  kind: SelfPlayFailureKind;
  reason: string;
}

export interface SelfPlayWorkerControlOptions {
  leaseMs: number;
  retryDelayMs?: number;
  now?: () => number;
  token?: () => string;
}

const RETRYABLE_CODES = new Set(['WORKER_KILLED', 'TIMEOUT', 'HEARTBEAT_LOST', 'UNAVAILABLE']);

export function classifySelfPlayFailure(error: unknown): FailureClassification {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const code = typeof record.code === 'string' ? record.code.toUpperCase() : '';
  const message = error instanceof Error ? error.message : String(error);
  const retryable =
    RETRYABLE_CODES.has(code) ||
    /timeout|timed out|worker killed|heartbeat|temporar|unavailable/i.test(message);
  return {
    kind: retryable ? 'retryable' : 'permanent',
    reason: code ? `${code}: ${message}` : message,
  };
}

/**
 * Process-local reference implementation of the self-play worker control contract.
 * Every mutating operation is synchronous, making lease acquisition atomic within the store.
 * A persistent/distributed adapter must provide the same compare-and-swap semantics.
 */
export class SelfPlayWorkerControl {
  private readonly records = new Map<string, LeasedSelfPlayJob>();
  private readonly now: () => number;
  private readonly token: () => string;
  private readonly retryDelayMs: number;

  constructor(private readonly options: SelfPlayWorkerControlOptions) {
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1)
      throw new Error('leaseMs must be positive');
    if (!Number.isSafeInteger(options.retryDelayMs ?? 0) || (options.retryDelayMs ?? 0) < 0)
      throw new Error('retryDelayMs must be non-negative');
    this.now = options.now ?? Date.now;
    this.token = options.token ?? (() => crypto.randomUUID());
    this.retryDelayMs = options.retryDelayMs ?? 0;
  }

  enqueue(job: SelfPlayJob, maxAttempts = 3): boolean {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
      throw new Error('maxAttempts must be positive');
    if (this.records.has(job.runId)) return false;
    this.records.set(job.runId, {
      job: structuredClone(job),
      state: 'queued',
      maxAttempts,
      nextEligibleAt: this.now(),
      lease: null,
      attempts: [],
    });
    return true;
  }

  acquire(workerId: string): JobLease | null {
    if (!workerId) throw new Error('workerId is required');
    this.recoverExpired();
    const now = this.now();
    const record = [...this.records.values()].find(
      (item) => item.state === 'queued' && item.nextEligibleAt <= now
    );
    if (!record) return null;
    const token = this.token();
    const attempt = record.attempts.length + 1;
    record.state = 'running';
    record.lease = { workerId, token, expiresAt: now + this.options.leaseMs };
    record.attempts.push({
      attempt,
      workerId,
      leaseToken: token,
      startedAt: now,
      heartbeatAt: now,
      finishedAt: null,
      state: 'running',
      failureReason: null,
      artifacts: [],
    });
    return {
      job: structuredClone(record.job),
      attempt,
      workerId,
      token,
      expiresAt: record.lease.expiresAt,
    };
  }

  heartbeat(runId: string, workerId: string, token: string): number {
    const { record, attempt } = this.active(runId, workerId, token);
    const now = this.now();
    if (record.lease!.expiresAt <= now) throw new Error(`lease expired for ${runId}`);
    record.lease!.expiresAt = now + this.options.leaseMs;
    attempt.heartbeatAt = now;
    return record.lease!.expiresAt;
  }

  recordArtifact(
    runId: string,
    workerId: string,
    token: string,
    artifact: SelfPlayAttemptArtifact
  ): void {
    const { attempt } = this.active(runId, workerId, token);
    if (!artifact.artifactId || !artifact.kind || !artifact.uri)
      throw new Error('artifact metadata is incomplete');
    if (attempt.artifacts.some((item) => item.artifactId === artifact.artifactId))
      throw new Error(`duplicate artifact ${artifact.artifactId}`);
    attempt.artifacts.push(structuredClone(artifact));
  }

  complete(runId: string, workerId: string, token: string): void {
    const { record, attempt } = this.active(runId, workerId, token);
    if (record.lease!.expiresAt <= this.now()) throw new Error(`lease expired for ${runId}`);
    attempt.state = 'completed';
    attempt.finishedAt = this.now();
    record.state = 'completed';
    record.lease = null;
  }

  fail(runId: string, workerId: string, token: string, error: unknown): FailureClassification {
    const { record, attempt } = this.active(runId, workerId, token);
    const failure = classifySelfPlayFailure(error);
    attempt.state = failure.kind === 'retryable' ? 'retryable_failure' : 'permanent_failure';
    attempt.failureReason = failure.reason;
    attempt.finishedAt = this.now();
    record.lease = null;
    if (failure.kind === 'retryable' && record.attempts.length < record.maxAttempts) {
      record.state = 'queued';
      record.nextEligibleAt = this.now() + this.retryDelayMs;
    } else {
      record.state = 'failed';
    }
    return failure;
  }

  recoverExpired(): string[] {
    const now = this.now();
    const recovered: string[] = [];
    for (const record of this.records.values()) {
      if (record.state !== 'running' || !record.lease || record.lease.expiresAt > now) continue;
      const attempt = record.attempts.at(-1)!;
      attempt.state = 'timed_out';
      attempt.failureReason = 'HEARTBEAT_LOST: lease expired';
      attempt.finishedAt = now;
      record.lease = null;
      if (record.attempts.length < record.maxAttempts) {
        record.state = 'queued';
        record.nextEligibleAt = now + this.retryDelayMs;
      } else {
        record.state = 'failed';
      }
      recovered.push(record.job.runId);
    }
    return recovered;
  }

  get(runId: string): LeasedSelfPlayJob | null {
    const record = this.records.get(runId);
    return record ? structuredClone(record) : null;
  }

  list(): LeasedSelfPlayJob[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  private active(
    runId: string,
    workerId: string,
    token: string
  ): { record: LeasedSelfPlayJob; attempt: SelfPlayAttempt } {
    const record = this.records.get(runId);
    if (!record || record.state !== 'running' || !record.lease)
      throw new Error(`job ${runId} is not running`);
    if (record.lease.workerId !== workerId || record.lease.token !== token)
      throw new Error(`lease ownership mismatch for ${runId}`);
    return { record, attempt: record.attempts.at(-1)! };
  }
}
