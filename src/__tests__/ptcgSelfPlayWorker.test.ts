import { SELF_PLAY_JOB_SCHEMA, type SelfPlayJob } from '../lib/ptcgSelfPlay.js';
import { SelfPlayWorkerControl, classifySelfPlayFailure } from '../lib/ptcgSelfPlayWorker.js';

const job = (runId: string): SelfPlayJob => ({
  schemaVersion: SELF_PLAY_JOB_SCHEMA,
  runId,
  seed: 1774,
  matches: 2,
  contestants: { first: 'submission.matsu', second: 'submission.take' },
  versions: { engine: 'cabt-1', environment: 'arena-1' },
});

describe('leased self-play worker execution', () => {
  let now: number;
  let sequence: number;
  let control: SelfPlayWorkerControl;

  beforeEach(() => {
    now = 1_000;
    sequence = 0;
    control = new SelfPlayWorkerControl({
      leaseMs: 100,
      now: () => now,
      token: () => `lease-${++sequence}`,
    });
  });

  it('allows only one owner to acquire and finalize a job', () => {
    control.enqueue(job('run.single-owner'));
    const first = control.acquire('worker-a')!;
    expect(control.acquire('worker-b')).toBeNull();
    expect(() => control.complete(first.job.runId, 'worker-b', first.token)).toThrow(
      'ownership mismatch'
    );
    control.complete(first.job.runId, first.workerId, first.token);
    expect(control.get(first.job.runId)?.state).toBe('completed');
    expect(() => control.complete(first.job.runId, first.workerId, first.token)).toThrow(
      'not running'
    );
  });

  it('extends a live lease with heartbeats', () => {
    control.enqueue(job('run.heartbeat'));
    const lease = control.acquire('worker-a')!;
    now = 1_080;
    expect(control.heartbeat(lease.job.runId, lease.workerId, lease.token)).toBe(1_180);
    now = 1_150;
    expect(control.recoverExpired()).toEqual([]);
  });

  it('recovers a job after worker kill or heartbeat loss and fences the stale worker', () => {
    control.enqueue(job('run.recovery'));
    const dead = control.acquire('worker-dead')!;
    now = 1_101;
    expect(control.recoverExpired()).toEqual(['run.recovery']);
    const resumed = control.acquire('worker-b')!;
    expect(resumed.attempt).toBe(2);
    expect(() => control.complete(dead.job.runId, dead.workerId, dead.token)).toThrow(
      'ownership mismatch'
    );
    control.complete(resumed.job.runId, resumed.workerId, resumed.token);
    expect(control.get('run.recovery')?.attempts.map((attempt) => attempt.state)).toEqual([
      'timed_out',
      'completed',
    ]);
  });

  it('stops at the retry limit and leaves unrelated jobs dispatchable', () => {
    control.enqueue(job('run.retry-limit'), 2);
    control.enqueue(job('run.healthy'));
    const first = control.acquire('worker-a')!;
    control.fail(
      first.job.runId,
      first.workerId,
      first.token,
      Object.assign(new Error('worker killed'), { code: 'WORKER_KILLED' })
    );
    const retry = control.acquire('worker-b')!;
    control.fail(retry.job.runId, retry.workerId, retry.token, new Error('temporary timeout'));
    const healthy = control.acquire('worker-c')!;
    control.complete(healthy.job.runId, healthy.workerId, healthy.token);
    expect(control.get('run.retry-limit')?.state).toBe('failed');
    expect(control.get('run.healthy')?.state).toBe('completed');
    expect(control.acquire('worker-d')).toBeNull();
  });

  it('quarantines a permanent failure without stopping the next job', () => {
    control.enqueue(job('run.invalid'));
    control.enqueue(job('run.next'));
    const invalid = control.acquire('worker-a')!;
    expect(
      control.fail(
        invalid.job.runId,
        invalid.workerId,
        invalid.token,
        new Error('invalid deck schema')
      ).kind
    ).toBe('permanent');
    const next = control.acquire('worker-b')!;
    expect(next.job.runId).toBe('run.next');
    expect(control.get('run.invalid')?.state).toBe('failed');
  });

  it('records attempt-scoped artifacts, transitions, and failure reasons', () => {
    control.enqueue(job('run.audit'));
    const first = control.acquire('worker-a')!;
    control.recordArtifact(first.job.runId, first.workerId, first.token, {
      artifactId: 'attempt-1-log',
      kind: 'worker-log',
      uri: 'file:///artifacts/attempt-1.log',
    });
    control.fail(
      first.job.runId,
      first.workerId,
      first.token,
      Object.assign(new Error('lost'), { code: 'HEARTBEAT_LOST' })
    );
    const retry = control.acquire('worker-b')!;
    control.complete(retry.job.runId, retry.workerId, retry.token);
    const attempts = control.get('run.audit')!.attempts;
    expect(attempts[0]).toMatchObject({
      attempt: 1,
      state: 'retryable_failure',
      failureReason: 'HEARTBEAT_LOST: lost',
    });
    expect(attempts[0].artifacts).toHaveLength(1);
    expect(attempts[1]).toMatchObject({ attempt: 2, state: 'completed', failureReason: null });
  });

  it('classifies known infrastructure failures as retryable and input defects as permanent', () => {
    expect(
      classifySelfPlayFailure(Object.assign(new Error('gone'), { code: 'UNAVAILABLE' })).kind
    ).toBe('retryable');
    expect(classifySelfPlayFailure(new Error('invalid policy payload')).kind).toBe('permanent');
  });
});
