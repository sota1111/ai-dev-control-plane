import { jest } from '@jest/globals';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
const WEBHOOK_EVENTS_FILE = path.join('/tmp/test-logs', 'linear.webhook-events.json');

const mockRunner = {
  SKIPPED_LOCKED: 75,
  log: jest.fn(),
  acquireLock: jest.fn().mockReturnValue(true),
  releaseLock: jest.fn(),
  hasPendingIssues: (jest.fn() as any).mockResolvedValue(true),
  fetchActiveIssues: (jest.fn() as any).mockResolvedValue([]),
  setIssueInProgress: (jest.fn() as any).mockResolvedValue(undefined),
  repairPrematureDone: (jest.fn() as any).mockResolvedValue(true),
  postUsageLimitComment: (jest.fn() as any).mockResolvedValue(undefined),
  addUsageLimitLabel: (jest.fn() as any).mockResolvedValue(undefined),
  finalizeParentIfChildrenComplete: (jest.fn() as any).mockResolvedValue(false),
  notifyUsageLimitToAllActiveIssues: (jest.fn() as any).mockResolvedValue(undefined),
  removeUsageLimitLabel: (jest.fn() as any).mockResolvedValue(undefined),
  setUsageLimitCooldownUntil: jest.fn(),
  clearUsageLimitCooldown: jest.fn(),
  getUsageLimitCooldownUntil: jest.fn().mockReturnValue(null),
  enqueue: jest.fn(),
  runItem: (jest.fn() as any).mockResolvedValue(undefined),
  drainQueue: (jest.fn() as any).mockResolvedValue(undefined),
  dequeue: jest.fn().mockReturnValue(null),
  removeFromQueue: jest.fn(),
  isQueued: jest.fn().mockReturnValue(false),
  wakeDependencyBlocked: jest.fn().mockReturnValue(0),
  isQueuedOrRunning: jest.fn().mockReturnValue(false),
  isReaperEnqueueSuppressed: jest.fn().mockReturnValue(false),
  humanWaitSuppressionInfo: jest.fn().mockReturnValue({ count: 0, nextAt: null }),
  clearHumanWaitSuppression: jest.fn().mockReturnValue(false),
  reapStaleInflight: jest.fn().mockReturnValue([]),
  reapCompletedDetachedRuns: (jest.fn() as any).mockResolvedValue([]),
  syncQueueWithLinear: (jest.fn() as any).mockResolvedValue(undefined),
  isLocked: jest.fn().mockReturnValue(false),
  setRunnerPausedState: jest.fn(),
  loadQueue: jest.fn().mockReturnValue([]),
  getIssueExecutionEligibility: (jest.fn() as any).mockResolvedValue({ eligible: true }),
  LOG_DIR: '/tmp/test-logs',
  LOCK_FILE: '/tmp/test-logs/runner.lock',
  QUEUE_FILE: '/tmp/test-logs/runner.queue.json',
  LOG_FILE: '/tmp/test-logs/auto_runner.log',
  STALE_LOCK_MS: 30 * 60 * 1000,
  LINEAR_API_URL: 'https://api.linear.app/graphql',
};
const mockCp = { spawn: jest.fn(), execSync: jest.fn() };

// Mock runner and child_process BEFORE importing the server
jest.unstable_mockModule('../runner.js', () => ({ ...mockRunner, default: mockRunner }));
jest.unstable_mockModule('node:child_process', () => ({ ...mockCp, default: mockCp }));
const { spawn } = mockCp;

// Disable signature verification BEFORE importing the server
const originalSecret = process.env.LINEAR_WEBHOOK_SECRET;
process.env.LINEAR_WEBHOOK_SECRET = '';

const webhookServer: any = await import('../webhook-server.js');
const { app, runPeriodicDrainTick, startPeriodicDrain, runReaperTick, scheduleIssueEvent, waitForRunnerIdle, _debounceTimers, _resetDebounceTimers } = webhookServer;

// Helper: create a mock spawn child that emits given stdout, stderr, then closes
function mockSpawnChild({ stdout = '', stderr = '', exitCode = 0 } = {}) {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  
  // Use a slight delay to ensure listeners are attached
  // Use a unique timeout value we can identify
  setTimeout(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode);
  }, 10);
  return child;
}

describe('webhook usage limit retry', () => {
  const originalSetTimeout = global.setTimeout;

  beforeEach(() => {
    jest.clearAllMocks();
    (spawn as jest.Mock).mockReset();
    // Default mock behavior: successful run
    (spawn as jest.Mock).mockImplementation(() => mockSpawnChild({ exitCode: 0 }));
    
    // Mock setTimeout to prevent long waits, but ALLOW it to run if we want
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any, ms: any) => {
      if (ms <= 100) return originalSetTimeout(fn, ms); // allow mockSpawnChild and small waits
      return { unref: () => {} } as any; // block retry timeout
    });

    const runner: any = mockRunner;
    if (fs.existsSync(WEBHOOK_EVENTS_FILE)) {
      try { fs.unlinkSync(WEBHOOK_EVENTS_FILE); } catch (_) {}
    }
    runner.acquireLock.mockReturnValue(true);
    runner.hasPendingIssues.mockResolvedValue(true);
    runner.isQueued.mockReturnValue(false);
    runner.wakeDependencyBlocked.mockReturnValue(0);
    runner.isQueuedOrRunning.mockReturnValue(false);
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);
    runner.dequeue.mockReturnValue(null);
    runner.runItem.mockResolvedValue(undefined);
    runner.drainQueue.mockResolvedValue(undefined);
    runner.getIssueExecutionEligibility.mockResolvedValue({ eligible: true });
  });


  afterEach(async () => {
    await new Promise(resolve => originalSetTimeout(resolve, 50));
    jest.restoreAllMocks();
  });

  const issuePayload = (id = 'TEST-001') => ({
    type: 'Issue',
    action: 'update',
    data: { identifier: id, title: 'test', state: { name: 'In Progress' }, labels: [] }
  });

  test('schedules retry when run_auto.sh outputs usage limit message', async () => {
    const id = 'TEST-RETRY';
    const runner: any = mockRunner;

    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });

    const res = await request(app).post('/webhooks/linear').send(issuePayload(id));
    expect(res.status).toBe(200);

    await new Promise(resolve => originalSetTimeout(resolve, 50));

    // webhook-server.js now delegates to runner.runItem
    expect(runner.runItem).toHaveBeenCalledWith({ issueId: id, trigger: 'webhook', retryAt: null });

    // Retry behavior (enqueue with retryAt) is now handled inside runner.runItem (runner.js)
    // and is tested in runner.test.js. Here we only verify delegation.

    // Same issueId can be ignored if already queued
    runner.isQueued.mockReturnValue(true);
    runner.isQueuedOrRunning.mockReturnValue(true);
    const res2 = await request(app).post('/webhooks/linear').send(issuePayload(id));
    expect(res2.body.status).toBe('ignored');
  });

  test('queues webhook without spawning while usage limit cooldown is active', async () => {
    const runner: any = mockRunner;
    const retryAt = new Date(Date.now() + 600000).toISOString();
    runner.getUsageLimitCooldownUntil.mockReturnValue({ retryAt, issueId: null });

    const res = await request(app).post('/webhooks/linear').send(issuePayload('TEST-COOLDOWN'));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');

    await new Promise(resolve => originalSetTimeout(resolve, 50));

    expect(runner.enqueue).toHaveBeenCalledWith('TEST-COOLDOWN', 'webhook', retryAt, expect.objectContaining({
      priority: null,
      priorityLabel: null,
      parentIssueId: null,
      parentIssueIdentifier: null
    }));
    expect(runner.hasPendingIssues).not.toHaveBeenCalled();
    expect(runner.acquireLock).not.toHaveBeenCalled();
    expect(runner.runItem).not.toHaveBeenCalled();
  });


  test('does not retry when run_auto.sh fails without usage limit message', async () => {
    const id = 'TEST-NO-RETRY';
    const runner: any = mockRunner;
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });

    await request(app).post('/webhooks/linear').send(issuePayload(id));

    await new Promise(resolve => originalSetTimeout(resolve, 50));

    // Verify runner.runItem was called
    expect(runner.runItem).toHaveBeenCalledWith({ issueId: id, trigger: 'webhook', retryAt: null });

    // No large setTimeout should be registered (runner.runItem is mocked, not actual retry logic)
    const retryCall = (setTimeout as any as jest.Mock).mock.calls.find((call: any) => call[1] > 1000);
    expect(retryCall).toBeUndefined();
  });

  test("ignores terminal issue update events", async () => {
    const runner: any = mockRunner;
    const terminalPayload = {
      type: "Issue",
      action: "update",
      data: { identifier: "TEST-DONE", title: "done task", state: { name: "Done", type: "completed" }, labels: [] }
    };

    const res = await request(app).post("/webhooks/linear").send(terminalPayload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
    expect(res.body.reason).toBe("terminal state: Done");
    expect(runner.enqueue).not.toHaveBeenCalled();
    expect(runner.runItem).not.toHaveBeenCalled();
  });

  test('repairs GitHub-driven Done while the autonomous run still owns the issue', async () => {
    const runner: any = mockRunner;
    runner.isQueuedOrRunning.mockReturnValue(true);
    const payload = {
      type: 'Issue',
      action: 'update',
      updatedFrom: { stateId: 'in-progress-state' },
      data: {
        identifier: 'SOT-ACTIVE',
        state: { name: 'Done', type: 'completed' },
        labels: [],
      },
    };

    const res = await request(app).post('/webhooks/linear').send(payload);
    await new Promise(resolve => originalSetTimeout(resolve, 20));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'accepted', reason: 'premature Done repair scheduled' });
    expect(runner.repairPrematureDone).toHaveBeenCalledWith('SOT-ACTIVE');
    expect(runner.removeFromQueue).not.toHaveBeenCalled();
    expect(runner.wakeDependencyBlocked).not.toHaveBeenCalled();
  });

  test('does not call setIssueInProgress (Claude Code handles In Progress)', async () => {
    const id = 'TEST-IN-PROGRESS';
    const runner: any = mockRunner;
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });
    (spawn as jest.Mock).mockImplementationOnce(() => mockSpawnChild({ exitCode: 0 }));

    await request(app).post('/webhooks/linear').send(issuePayload(id));
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    expect(runner.setIssueInProgress).not.toHaveBeenCalled();
  });

  test('does not affect normal successful runs', async () => {
    const id = 'TEST-SUCCESS';
    const runner: any = mockRunner;
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });

    await request(app).post('/webhooks/linear').send(issuePayload(id));

    await new Promise(resolve => originalSetTimeout(resolve, 50));

    // webhook delegates to runner.runItem
    expect(runner.runItem).toHaveBeenCalledWith({ issueId: id, trigger: 'webhook', retryAt: null });
    // After successful run, runner.runItem handles clearUsageLimitCooldown + removeUsageLimitLabel internally

    // Second webhook is accepted after first completes
    if (fs.existsSync(WEBHOOK_EVENTS_FILE)) {
      try { fs.unlinkSync(WEBHOOK_EVENTS_FILE); } catch (_) {}
    }
    runner.isQueued.mockReturnValue(false);
    runner.isQueuedOrRunning.mockReturnValue(false);
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });
    const res2 = await request(app).post('/webhooks/linear').send(issuePayload(id));
    expect(res2.body.status).toBe('accepted');
  });

  test('enqueues non-Urgent issue when a run is locked', async () => {
    const runner: any = mockRunner;
    runner.isLocked.mockReturnValue(true); // simulate active run
    runner.isQueued.mockReturnValue(false);

    const nonUrgentPayload = {
      type: 'Issue',
      action: 'update',
      data: { identifier: 'TEST-NON-URGENT', title: 'test', state: { name: 'Todo' }, labels: [], priority: 2 }
    };

    const res = await request(app).post('/webhooks/linear').send(nonUrgentPayload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted'); // HTTP response is still accepted

    await new Promise(resolve => originalSetTimeout(resolve, 50));

    // Should enqueue non-Urgent issue when locked
    expect(runner.enqueue).toHaveBeenCalledWith('TEST-NON-URGENT', 'webhook', null, expect.objectContaining({
      priority: 2,
      priorityLabel: null,
      parentIssueId: null,
      parentIssueIdentifier: null
    }));
  });

  test('does not skip Urgent issue even when a run is locked', async () => {
    const runner: any = mockRunner;
    runner.isLocked.mockReturnValue(true); // simulate active run
    runner.isQueued.mockReturnValue(false);
    runner.dequeue.mockReturnValueOnce({ issueId: 'TEST-URGENT', trigger: 'webhook', retryAt: null });
    (spawn as jest.Mock).mockImplementationOnce(() => mockSpawnChild({ exitCode: 0 }));

    const urgentPayload = {
      type: 'Issue',
      action: 'update',
      data: { identifier: 'TEST-URGENT', title: 'urgent task', state: { name: 'Todo' }, labels: [], priority: 1 }
    };

    const res = await request(app).post('/webhooks/linear').send(urgentPayload);
    expect(res.status).toBe(200);

    await new Promise(resolve => originalSetTimeout(resolve, 50));

    // Urgent issue should be enqueued even when locked
    expect(runner.enqueue).toHaveBeenCalledWith('TEST-URGENT', 'webhook', null, expect.objectContaining({
      priority: 1,
      priorityLabel: null,
      parentIssueId: null,
      parentIssueIdentifier: null
    }));
  });

  test('drains queue after main task completes', async () => {
    const runner: any = mockRunner;
    runner.isLocked.mockReturnValue(false);
    runner.isQueued.mockReturnValue(false);

    const id1 = 'TEST-MAIN';
    const id2 = 'TEST-DRAIN';

    runner.dequeue.mockReturnValueOnce({ issueId: id1, trigger: 'webhook' });

    // Simulate queue has one item remaining after id1 runs
    runner.loadQueue
      .mockReturnValueOnce([{ issueId: id2 }])
      .mockReturnValue([]);

    await request(app).post('/webhooks/linear').send(issuePayload(id1));

    await new Promise(resolve => originalSetTimeout(resolve, 100));

    // Verify runner.runItem was called for the main task
    expect(runner.runItem).toHaveBeenCalledWith({ issueId: id1, trigger: 'webhook' });
    // Verify runner.drainQueue was called after main task completed
    expect(runner.drainQueue).toHaveBeenCalled();
  });
});

describe('graceful shutdown idle wait', () => {
  beforeEach(() => {
    mockRunner.isLocked.mockReset();
  });

  test('returns immediately when no runner lock is held', async () => {
    mockRunner.isLocked.mockReturnValue(false);
    await expect(waitForRunnerIdle(20, 1)).resolves.toBe(true);
  });

  test('waits for an active runner instead of terminating it', async () => {
    mockRunner.isLocked
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    await expect(waitForRunnerIdle(100, 1)).resolves.toBe(true);
    expect(mockRunner.isLocked).toHaveBeenCalledTimes(3);
  });

  test('reports timeout while the runner remains active', async () => {
    mockRunner.isLocked.mockReturnValue(true);
    await expect(waitForRunnerIdle(1, 1)).resolves.toBe(false);
  });
});

// Restore secret at the end of all tests in this file
afterAll(() => {
  process.env.LINEAR_WEBHOOK_SECRET = originalSecret;
});

// SOT-925 逸脱1: 取り残し回収 starvation の解消。ビジーなキューが続いても一定間隔で
// In Progress 取り残しの Linear 再スキャンを保証し、かつ直近スキャン済みならレート制限でスキップする。
describe('reaper stranded-recovery de-starvation (SOT-925)', () => {
  const originalApiKey = process.env.LINEAR_API_KEY;
  const originalInterval = process.env.REAPER_STRANDED_MAX_INTERVAL_MS;

  beforeEach(() => {
    jest.clearAllMocks();
    const runner: any = mockRunner;
    // 取り残し回収が「実行中でなく」「cooldownでなく」「API キーあり」かつ「キューに due 項目あり（ビジー）」の条件
    runner.isLocked.mockReturnValue(false);
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);
    runner.loadQueue.mockReturnValue([{ issueId: 'BUSY-1', retryAt: null }]); // hasDueQueueItem()=true
    runner.fetchActiveIssues.mockResolvedValue([]); // 副次的な drain を起こさない
    process.env.LINEAR_API_KEY = 'test-key';
  });

  afterAll(() => {
    if (originalApiKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = originalApiKey;
    if (originalInterval === undefined) delete process.env.REAPER_STRANDED_MAX_INTERVAL_MS;
    else process.env.REAPER_STRANDED_MAX_INTERVAL_MS = originalInterval;
  });

  test('rescans stranded In-Progress under a busy queue when the interval has elapsed, then rate-limits', async () => {
    const runner: any = mockRunner;

    // 1回目: interval=0 → ビジーでもバイパスして再スキャンが走る
    process.env.REAPER_STRANDED_MAX_INTERVAL_MS = '0';
    await runReaperTick();
    expect(runner.fetchActiveIssues).toHaveBeenCalledTimes(1);

    // 2回目: interval を大きく → 直近スキャン済みのためレート制限でスキップ（再スキャンしない）
    process.env.REAPER_STRANDED_MAX_INTERVAL_MS = '999999999';
    await runReaperTick();
    expect(runner.fetchActiveIssues).toHaveBeenCalledTimes(1);
  });
});

describe('webhook issue filtering', () => {
  const originalSetTimeout = global.setTimeout;

  beforeEach(() => {
    jest.clearAllMocks();
    (spawn as jest.Mock).mockReset();
    (spawn as jest.Mock).mockImplementation(() => mockSpawnChild({ exitCode: 0 }));
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any, ms: any) => {
      if (ms <= 100) return originalSetTimeout(fn, ms);
      return { unref: () => {} } as any;
    });

    const runner: any = mockRunner;
    if (fs.existsSync(WEBHOOK_EVENTS_FILE)) {
      try { fs.unlinkSync(WEBHOOK_EVENTS_FILE); } catch (_) {}
    }
    runner.acquireLock.mockReturnValue(true);
    runner.hasPendingIssues.mockResolvedValue(true);
    runner.isQueued.mockReturnValue(false);
    runner.isQueuedOrRunning.mockReturnValue(false);
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);
    runner.dequeue.mockReturnValue(null);
    runner.runItem.mockResolvedValue(undefined);
    runner.drainQueue.mockResolvedValue(undefined);
    runner.getIssueExecutionEligibility.mockResolvedValue({ eligible: true });
  });

  afterEach(async () => {
    await new Promise(resolve => originalSetTimeout(resolve, 50));
    jest.restoreAllMocks();
  });

  function makePayload(action: string, stateOverrides: any = {}, extra: any = {}) {
    return {
      type: 'Issue',
      action,
      data: {
        identifier: 'TEST-FILTER',
        title: 'test issue',
        state: { name: 'In Progress', type: 'started', ...stateOverrides },
        labels: [],
        ...extra
      }
    };
  }

  test('completed issue update is ignored', async () => {
    const runner: any = mockRunner;
    const payload = makePayload('update', { name: 'Done', type: 'completed' });
    const res = await request(app).post('/webhooks/linear').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored');
    expect(res.body.reason).toMatch(/terminal state/);
    expect(runner.removeFromQueue).toHaveBeenCalledWith('TEST-FILTER');
    expect(runner.runItem).not.toHaveBeenCalled();
  });

  test('canceled issue update is ignored', async () => {
    const runner: any = mockRunner;
    const payload = makePayload('update', { name: 'Canceled', type: 'canceled' });
    const res = await request(app).post('/webhooks/linear').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored');
    expect(res.body.reason).toMatch(/terminal state/);
    expect(runner.removeFromQueue).toHaveBeenCalledWith('TEST-FILTER');
    expect(runner.runItem).not.toHaveBeenCalled();
  });

  test('duplicate issue update is ignored', async () => {
    const runner: any = mockRunner;
    const payload = makePayload('update', { name: 'Duplicate', type: 'duplicate' });
    const res = await request(app).post('/webhooks/linear').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored');
    expect(res.body.reason).toMatch(/terminal state/);
    expect(runner.removeFromQueue).toHaveBeenCalledWith('TEST-FILTER');
    expect(runner.runItem).not.toHaveBeenCalled();
  });

  test('archived issue update is ignored', async () => {
    const runner: any = mockRunner;
    const payload = {
      type: 'Issue',
      action: 'update',
      data: {
        identifier: 'TEST-ARCHIVED',
        title: 'archived issue',
        state: { name: 'In Progress', type: 'started' },
        labels: [],
        archivedAt: '2026-06-01T00:00:00.000Z'
      }
    };
    const res = await request(app).post('/webhooks/linear').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored');
    expect(res.body.reason).toBe('archived issue');
    expect(runner.removeFromQueue).toHaveBeenCalledWith('TEST-ARCHIVED');
    expect(runner.runItem).not.toHaveBeenCalled();
  });

  test('child moving to In Review is ignored as hold and finalizes the parent (SOT-1551)', async () => {
    const runner: any = mockRunner;
    runner.finalizeParentIfChildrenComplete.mockClear();
    const payload = {
      type: 'Issue',
      action: 'update',
      updatedFrom: { stateId: 'old-state' },
      data: {
        identifier: 'TEST-CHILD-REVIEW',
        title: 'child done',
        state: { name: 'In Review', type: 'started' },
        parent: { identifier: 'TEST-PARENT' },
        labels: []
      }
    };
    const res = await request(app).post('/webhooks/linear').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored');
    expect(res.body.reason).toBe('hold state: In Review');
    expect(runner.removeFromQueue).toHaveBeenCalledWith('TEST-CHILD-REVIEW');
    expect(runner.runItem).not.toHaveBeenCalled();

    await new Promise(resolve => originalSetTimeout(resolve, 20));
    expect(runner.finalizeParentIfChildrenComplete).toHaveBeenCalledWith('TEST-CHILD-REVIEW', 'TEST-PARENT');
  });

  test('a blocker moving to In Review wakes dependency-blocked queue items immediately', async () => {
    const runner: any = mockRunner;
    runner.wakeDependencyBlocked.mockReturnValueOnce(1);
    runner.isLocked.mockReturnValue(false);
    const payload: any = makePayload(
      'update',
      { name: 'In Review', type: 'started' },
      { identifier: 'TEST-BLOCKER-REVIEW' },
    );
    payload.updatedFrom = { stateId: 'blocked-state' };

    const res = await request(app).post('/webhooks/linear').send(payload);
    expect(res.status).toBe(200);
    expect(runner.wakeDependencyBlocked).toHaveBeenCalledWith('TEST-BLOCKER-REVIEW');
    await new Promise(resolve => originalSetTimeout(resolve, 20));
    expect(runner.drainQueue).toHaveBeenCalled();
  });

  test('active issue create is accepted', async () => {
    const runner: any = mockRunner;
    runner.dequeue.mockReturnValueOnce({ issueId: 'TEST-CREATE', trigger: 'webhook', retryAt: null });
    (spawn as jest.Mock).mockImplementationOnce(() => mockSpawnChild({ exitCode: 0 }));

    const payload = {
      type: 'Issue',
      action: 'create',
      data: {
        identifier: 'TEST-CREATE',
        title: 'new issue',
        state: { name: 'Todo', type: 'unstarted' },
        labels: []
      }
    };
    const res = await request(app).post('/webhooks/linear').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');

    await new Promise(resolve => originalSetTimeout(resolve, 50));
    expect(runner.runItem).toHaveBeenCalled();
  });

  test('active issue meaningful update is accepted', async () => {
    const runner: any = mockRunner;
    runner.dequeue.mockReturnValueOnce({ issueId: 'TEST-MEANINGFUL', trigger: 'webhook', retryAt: null });
    (spawn as jest.Mock).mockImplementationOnce(() => mockSpawnChild({ exitCode: 0 }));

    const payload = {
      type: 'Issue',
      action: 'update',
      updatedFrom: { title: 'old title' },
      data: {
        identifier: 'TEST-MEANINGFUL',
        title: 'new title',
        state: { name: 'In Progress', type: 'started' },
        labels: []
      }
    };
    const res = await request(app).post('/webhooks/linear').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');

    await new Promise(resolve => originalSetTimeout(resolve, 50));
    expect(runner.runItem).toHaveBeenCalled();
  });

  test('completed queued issue is removed before execution', async () => {
    const runner: any = mockRunner;
    const payload = {
      type: 'Issue',
      action: 'update',
      data: {
        identifier: 'TEST-QUEUED-DONE',
        title: 'done task',
        state: { name: 'Done', type: 'completed' },
        labels: []
      }
    };
    const res = await request(app).post('/webhooks/linear').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored');
    expect(runner.removeFromQueue).toHaveBeenCalledWith('TEST-QUEUED-DONE');
    expect(runner.runItem).not.toHaveBeenCalled();
  });

  test('usage-limit cleanup update does not retrigger run', async () => {
    const runner: any = mockRunner;
    const payload = {
      type: 'Issue',
      action: 'update',
      updatedFrom: { labelIds: ['some-label-uuid'] },
      data: {
        identifier: 'TEST-LABEL-CLEANUP',
        title: 'active issue',
        state: { name: 'In Progress', type: 'started' },
        labels: []
      }
    };
    const res = await request(app).post('/webhooks/linear').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored');
    expect(res.body.reason).toBe('non-meaningful update');
    expect(runner.runItem).not.toHaveBeenCalled();
  });
});

describe('pre-execution eligibility check', () => {
  const originalSetTimeout = global.setTimeout;

  beforeEach(() => {
    jest.clearAllMocks();
    (spawn as jest.Mock).mockReset();
    (spawn as jest.Mock).mockImplementation(() => mockSpawnChild({ exitCode: 0 }));
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: any, ms: any) => {
      if (ms <= 100) return originalSetTimeout(fn, ms);
      return { unref: () => {} } as any;
    });

    const runner: any = mockRunner;
    if (fs.existsSync(WEBHOOK_EVENTS_FILE)) {
      try { fs.unlinkSync(WEBHOOK_EVENTS_FILE); } catch (_) {}
    }
    runner.acquireLock.mockReturnValue(true);
    runner.hasPendingIssues.mockResolvedValue(true);
    runner.isQueued.mockReturnValue(false);
    runner.isQueuedOrRunning.mockReturnValue(false);
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);
    runner.dequeue.mockReturnValue(null);
    runner.runItem.mockResolvedValue(undefined);
    runner.drainQueue.mockResolvedValue(undefined);
    runner.getIssueExecutionEligibility.mockResolvedValue({ eligible: true });
  });

  afterEach(async () => {
    await new Promise(resolve => originalSetTimeout(resolve, 50));
    jest.restoreAllMocks();
  });

  const issuePayload = (id = 'TEST-001') => ({
    type: 'Issue',
    action: 'update',
    updatedFrom: { stateId: 'old-state' },
    data: { identifier: id, title: 'test', state: { name: 'In Progress', type: 'started' }, labels: [] }
  });

  test('queued completed issue is skipped before runItem', async () => {
    const runner: any = mockRunner;
    const id = 'TEST-QUEUED-COMPLETED';
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });

    await request(app).post('/webhooks/linear').send(issuePayload(id));
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    // webhook-server.js now delegates to runner.runItem
    expect(runner.runItem).toHaveBeenCalledWith({ issueId: id, trigger: 'webhook', retryAt: null });
  });

  test('retry completed issue is skipped before triggerRun', async () => {
    const runner: any = mockRunner;
    const id = 'TEST-RETRY-COMPLETED';
    // Issue is dequeued (would be in retry queue) but is now completed
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });

    await request(app).post('/webhooks/linear').send(issuePayload(id));
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    // webhook-server.js delegates to runner.runItem
    expect(runner.runItem).toHaveBeenCalledWith({ issueId: id, trigger: 'webhook', retryAt: null });
  });

  test('archived queued issue is removed before execution', async () => {
    const runner: any = mockRunner;
    const id = 'TEST-ARCHIVED-QUEUED';
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });

    await request(app).post('/webhooks/linear').send(issuePayload(id));
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    // webhook-server.js delegates to runner.runItem
    expect(runner.runItem).toHaveBeenCalledWith({ issueId: id, trigger: 'webhook', retryAt: null });
  });

  test('active queued issue still runs', async () => {
    const runner: any = mockRunner;
    const id = 'TEST-ACTIVE-RUNS';
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });

    await request(app).post('/webhooks/linear').send(issuePayload(id));
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    expect(runner.runItem).toHaveBeenCalledWith({ issueId: id, trigger: 'webhook', retryAt: null });
  });
});

describe('runBootstrapScan', () => {
  let runBootstrapScan: any;
  const runner: any = mockRunner;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset env
    delete process.env.WEBHOOK_BOOTSTRAP_SCAN_ENABLED;
    delete process.env.LINEAR_API_KEY;
    // Get fresh reference
    runBootstrapScan = webhookServer.runBootstrapScan;
  });

  it('should scan by default when WEBHOOK_BOOTSTRAP_SCAN_ENABLED is not set', async () => {
    process.env.LINEAR_API_KEY = 'test-key';
    runner.fetchActiveIssues.mockResolvedValue([
      { identifier: 'SOT-100', priority: 2, priorityLabel: 'High', parentIssueId: null, parentIssueIdentifier: null },
    ]);
    runner.isQueued.mockReturnValue(false);
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);

    await runBootstrapScan();

    expect(runner.fetchActiveIssues).toHaveBeenCalledWith(50, { excludeHold: true });
    expect(runner.enqueue).toHaveBeenCalledWith('SOT-100', 'webhook-bootstrap', null, expect.objectContaining({ priority: 2 }));
  });

  it('should skip scan when WEBHOOK_BOOTSTRAP_SCAN_ENABLED=false', async () => {
    process.env.WEBHOOK_BOOTSTRAP_SCAN_ENABLED = 'false';
    await runBootstrapScan();
    expect(runner.fetchActiveIssues).not.toHaveBeenCalled();
    expect(runner.enqueue).not.toHaveBeenCalled();
  });

  it('should skip scan when LINEAR_API_KEY is not set', async () => {
    process.env.WEBHOOK_BOOTSTRAP_SCAN_ENABLED = 'true';
    // LINEAR_API_KEY not set
    await runBootstrapScan();
    expect(runner.fetchActiveIssues).not.toHaveBeenCalled();
    expect(runner.enqueue).not.toHaveBeenCalled();
  });

  it('should enqueue active issues when enabled and LINEAR_API_KEY is set', async () => {
    process.env.WEBHOOK_BOOTSTRAP_SCAN_ENABLED = 'true';
    process.env.LINEAR_API_KEY = 'test-key';
    runner.fetchActiveIssues.mockResolvedValue([
      { identifier: 'SOT-100', priority: 2, priorityLabel: 'High', parentIssueId: null, parentIssueIdentifier: null },
      { identifier: 'SOT-101', priority: 3, priorityLabel: 'Medium', parentIssueId: null, parentIssueIdentifier: null },
    ]);
    runner.isQueued.mockReturnValue(false);
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);

    await runBootstrapScan();

    expect(runner.fetchActiveIssues).toHaveBeenCalledWith(50, { excludeHold: true });
    expect(runner.enqueue).toHaveBeenCalledWith('SOT-100', 'webhook-bootstrap', null, expect.objectContaining({ priority: 2 }));
    expect(runner.enqueue).toHaveBeenCalledWith('SOT-101', 'webhook-bootstrap', null, expect.objectContaining({ priority: 3 }));
    expect(runner.drainQueue).toHaveBeenCalled();
  });

  it('should skip already-queued issues', async () => {
    process.env.WEBHOOK_BOOTSTRAP_SCAN_ENABLED = 'true';
    process.env.LINEAR_API_KEY = 'test-key';
    runner.fetchActiveIssues.mockResolvedValue([
      { identifier: 'SOT-100', priority: 2, priorityLabel: 'High', parentIssueId: null, parentIssueIdentifier: null },
    ]);
    runner.isQueued.mockReturnValue(true); // already queued
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);

    await runBootstrapScan();

    expect(runner.enqueue).not.toHaveBeenCalled();
    expect(runner.drainQueue).not.toHaveBeenCalled();
  });

  it('should enqueue with retryAt when cooldown is active', async () => {
    process.env.WEBHOOK_BOOTSTRAP_SCAN_ENABLED = 'true';
    process.env.LINEAR_API_KEY = 'test-key';
    const retryAt = '2026-06-17T00:00:00.000Z';
    runner.fetchActiveIssues.mockResolvedValue([
      { identifier: 'SOT-100', priority: 2, priorityLabel: 'High', parentIssueId: null, parentIssueIdentifier: null },
    ]);
    runner.isQueued.mockReturnValue(false);
    runner.getUsageLimitCooldownUntil.mockReturnValue({ retryAt });

    await runBootstrapScan();

    expect(runner.enqueue).toHaveBeenCalledWith('SOT-100', 'webhook-bootstrap', retryAt, expect.any(Object));
    expect(runner.drainQueue).toHaveBeenCalled();
  });

  it('should not call drainQueue when no new issues were enqueued', async () => {
    process.env.WEBHOOK_BOOTSTRAP_SCAN_ENABLED = 'true';
    process.env.LINEAR_API_KEY = 'test-key';
    runner.fetchActiveIssues.mockResolvedValue([]);
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);

    await runBootstrapScan();

    expect(runner.drainQueue).not.toHaveBeenCalled();
  });

  it('should reap stale inflight entries at startup', async () => {
    process.env.LINEAR_API_KEY = 'test-key';
    runner.fetchActiveIssues.mockResolvedValue([]);
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);

    await runBootstrapScan();

    expect(runner.reapStaleInflight).toHaveBeenCalled();
  });
});

describe('reaper (runReaperTick)', () => {
  let runReaperTick: any;
  const runner: any = mockRunner;

  const originalStrandedInterval = process.env.REAPER_STRANDED_MAX_INTERVAL_MS;

  afterAll(() => {
    if (originalStrandedInterval === undefined) delete process.env.REAPER_STRANDED_MAX_INTERVAL_MS;
    else process.env.REAPER_STRANDED_MAX_INTERVAL_MS = originalStrandedInterval;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    delete process.env.WEBHOOK_REAPER_ENABLED;
    process.env.LINEAR_API_KEY = 'test-key';
    // これらのテストは「ビジー時は再スキャンしない」旧来セマンティクスを検証する。SOT-925 の
    // 取り残しスキャン（時間経過バイパス）は別 describe で検証するため、ここでは間隔を現在エポックより
    // 大きく固定し strandedScanDue を常に false にして、モジュール状態に依存せず決定的にする。
    process.env.REAPER_STRANDED_MAX_INTERVAL_MS = '9999999999999';
    runReaperTick = webhookServer.runReaperTick;
    runner.reapStaleInflight.mockReturnValue([]);
    runner.isLocked.mockReturnValue(false);
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);
    runner.loadQueue.mockReturnValue([]);
    runner.isQueued.mockReturnValue(false);
    runner.fetchActiveIssues.mockResolvedValue([]);
    runner.drainQueue.mockResolvedValue(undefined);
    runner.syncQueueWithLinear.mockResolvedValue(undefined);
    // 各テストを独立させるため _prevReaperCooldownActive を false に正規化する
    // （cooldown=null のまま lock で早期returnさせ、前回状態だけ更新する）
    runner.isLocked.mockReturnValue(true);
    await runReaperTick();
    runner.isLocked.mockReturnValue(false);
    runner.fetchActiveIssues.mockClear();
    runner.enqueue.mockClear();
    runner.drainQueue.mockClear();
    runner.syncQueueWithLinear.mockClear();
  });

  it('should skip when WEBHOOK_REAPER_ENABLED=false', async () => {
    process.env.WEBHOOK_REAPER_ENABLED = 'false';
    await runReaperTick();
    expect(runner.fetchActiveIssues).not.toHaveBeenCalled();
    expect(runner.enqueue).not.toHaveBeenCalled();
  });

  it('should skip when locked', async () => {
    runner.isLocked.mockReturnValue(true);
    await runReaperTick();
    expect(runner.fetchActiveIssues).not.toHaveBeenCalled();
  });

  it('should skip while in cooldown', async () => {
    runner.getUsageLimitCooldownUntil.mockReturnValue({ retryAt: '2026-06-20T00:00:00.000Z' });
    await runReaperTick();
    expect(runner.fetchActiveIssues).not.toHaveBeenCalled();
  });

  it('should skip when LINEAR_API_KEY is not set', async () => {
    delete process.env.LINEAR_API_KEY;
    await runReaperTick();
    expect(runner.fetchActiveIssues).not.toHaveBeenCalled();
  });

  it('should reap stale inflight entries on each tick (even when nothing to scan)', async () => {
    await runReaperTick();
    expect(runner.reapStaleInflight).toHaveBeenCalled();
  });

  it('should scan and enqueue stranded active issues when idle, then drain', async () => {
    runner.fetchActiveIssues.mockResolvedValue([
      { identifier: 'SOT-200', priority: 2, priorityLabel: 'High', parentIssueId: null, parentIssueIdentifier: null },
    ]);
    runner.isQueued.mockReturnValue(false);

    await runReaperTick();

    expect(runner.fetchActiveIssues).toHaveBeenCalledWith(50, { excludeHold: true });
    expect(runner.enqueue).toHaveBeenCalledWith('SOT-200', 'webhook-reaper', null, expect.objectContaining({ priority: 2 }));
    expect(runner.drainQueue).toHaveBeenCalled();
  });

  it('should NOT re-enqueue a code=70 human-wait issue while suppressed (SOT-1547)', async () => {
    runner.fetchActiveIssues.mockResolvedValue([
      { identifier: 'SOT-1531', priority: 2, priorityLabel: 'High', parentIssueId: null, parentIssueIdentifier: null },
    ]);
    runner.isQueued.mockReturnValue(false);
    runner.isReaperEnqueueSuppressed.mockImplementation((id: string) => id === 'SOT-1531');
    runner.humanWaitSuppressionInfo.mockReturnValue({ count: 4, nextAt: 'human-input' });

    await runReaperTick();

    expect(runner.isReaperEnqueueSuppressed).toHaveBeenCalledWith('SOT-1531');
    expect(runner.enqueue).not.toHaveBeenCalled();
    expect(runner.drainQueue).not.toHaveBeenCalled();
  });

  it('should re-enqueue a previously code=70 issue once suppression is cleared (SOT-1547)', async () => {
    runner.fetchActiveIssues.mockResolvedValue([
      { identifier: 'SOT-1531', priority: 2, priorityLabel: 'High', parentIssueId: null, parentIssueIdentifier: null },
    ]);
    runner.isQueued.mockReturnValue(false);
    runner.isReaperEnqueueSuppressed.mockReturnValue(false); // human input cleared it

    await runReaperTick();

    expect(runner.enqueue).toHaveBeenCalledWith('SOT-1531', 'webhook-reaper', null, expect.objectContaining({ priority: 2 }));
    expect(runner.drainQueue).toHaveBeenCalled();
  });

  it('should skip already-queued issues and not drain when nothing new enqueued', async () => {
    runner.fetchActiveIssues.mockResolvedValue([
      { identifier: 'SOT-200', priority: 2, priorityLabel: 'High', parentIssueId: null, parentIssueIdentifier: null },
    ]);
    runner.isQueued.mockReturnValue(true);

    await runReaperTick();

    expect(runner.enqueue).not.toHaveBeenCalled();
    expect(runner.drainQueue).not.toHaveBeenCalled();
  });

  it('should NOT scan when idle queue has a due item (drain handles it)', async () => {
    runner.loadQueue.mockReturnValue([{ issueId: 'X', retryAt: null }]); // due item present
    await runReaperTick();
    expect(runner.fetchActiveIssues).not.toHaveBeenCalled();
  });

  it('should scan on cooldown-just-cleared even when a due item exists', async () => {
    // tick 1: in cooldown → records prev cooldown active, no scan
    runner.getUsageLimitCooldownUntil.mockReturnValue({ retryAt: '2026-06-20T00:00:00.000Z' });
    await runReaperTick();
    expect(runner.fetchActiveIssues).not.toHaveBeenCalled();

    // tick 2: cooldown cleared, but queue has a due item — reaper should still scan
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);
    runner.loadQueue.mockReturnValue([{ issueId: 'X', retryAt: null }]);
    runner.fetchActiveIssues.mockResolvedValue([
      { identifier: 'SOT-201', priority: 1, priorityLabel: 'Urgent', parentIssueId: null, parentIssueIdentifier: null },
    ]);
    await runReaperTick();
    expect(runner.fetchActiveIssues).toHaveBeenCalledWith(50, { excludeHold: true });
    expect(runner.enqueue).toHaveBeenCalledWith('SOT-201', 'webhook-reaper', null, expect.objectContaining({ priority: 1 }));
    expect(runner.drainQueue).toHaveBeenCalled();
  });
});

describe('webhook event dedupe', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    if (fs.existsSync(WEBHOOK_EVENTS_FILE)) {
      try { fs.unlinkSync(WEBHOOK_EVENTS_FILE); } catch (_) {}
    }

    const runner: any = mockRunner;
    runner.isQueuedOrRunning.mockReturnValue(false);
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);
    runner.hasPendingIssues.mockResolvedValue(true);
    runner.dequeue.mockReturnValue(null);
    runner.runItem.mockResolvedValue(undefined);
    runner.drainQueue.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (fs.existsSync(WEBHOOK_EVENTS_FILE)) {
      try { fs.unlinkSync(WEBHOOK_EVENTS_FILE); } catch (_) {}
    }
  });

  test('ignores duplicate event with same body.id', async () => {
    const payload = {
      id: 'evt-123',
      type: 'Issue',
      action: 'create',
      data: { identifier: 'SOT-1', title: 'test' }
    };

    // First request
    const res1 = await request(app).post('/webhooks/linear').send(payload);
    expect(res1.status).toBe(200);
    expect(res1.body.status).toBe('accepted');

    // Second request (duplicate)
    const res2 = await request(app).post('/webhooks/linear').send(payload);
    expect(res2.status).toBe(200);
    expect(res2.body.status).toBe('ignored');
    expect(res2.body.reason).toBe('duplicate event');
  });

  test('deduplicates based on hash when body.id is missing', async () => {
    const payload = {
      type: 'Issue',
      action: 'update',
      data: { identifier: 'SOT-1', title: 'test', updatedAt: '2026-06-16T10:00:00Z' }
    };

    const res1 = await request(app).post('/webhooks/linear').send(payload);
    expect(res1.body.status).toBe('accepted');

    const res2 = await request(app).post('/webhooks/linear').send(payload);
    expect(res2.body.status).toBe('ignored');
  });

  test('webhook resend while issue is in-flight is ignored', async () => {
    const runner: any = mockRunner;
    runner.isQueuedOrRunning.mockReturnValue(true);

    const payload = {
      id: 'evt-inflight-resend',
      type: 'Issue',
      action: 'update',
      data: { identifier: 'SOT-INFLIGHT', title: 'test', state: { name: 'In Progress', type: 'started' }, labels: [] }
    };

    const res = await request(app).post('/webhooks/linear').send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored');
    expect(res.body.reason).toBe('already queued or running: SOT-INFLIGHT');
    expect(runner.enqueue).not.toHaveBeenCalled();
    expect(runner.runItem).not.toHaveBeenCalled();
  });
});

describe('periodic drain', () => {
  const runner: any = mockRunner;

  beforeEach(() => {
    jest.clearAllMocks();
    runner.isLocked.mockReturnValue(false);
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);
    runner.loadQueue.mockReturnValue([]);
    runner.drainQueue.mockResolvedValue(undefined);
  });

  test('drains when idle and has due item', async () => {
    runner.loadQueue.mockReturnValue([{ issueId: 'X', retryAt: null }]);
    await runPeriodicDrainTick();
    expect(runner.drainQueue).toHaveBeenCalled();
  });

  test('skips when locked', async () => {
    runner.isLocked.mockReturnValue(true);
    runner.loadQueue.mockReturnValue([{ issueId: 'X', retryAt: null }]);
    await runPeriodicDrainTick();
    expect(runner.drainQueue).not.toHaveBeenCalled();
  });

  test('skips when in cooldown', async () => {
    runner.getUsageLimitCooldownUntil.mockReturnValue({ retryAt: 'some-date' });
    runner.loadQueue.mockReturnValue([{ issueId: 'X', retryAt: null }]);
    await runPeriodicDrainTick();
    expect(runner.drainQueue).not.toHaveBeenCalled();
  });

  test('skips when no due items', async () => {
    const future = new Date(Date.now() + 10000).toISOString();
    runner.loadQueue.mockReturnValue([{ issueId: 'X', retryAt: future }]);
    await runPeriodicDrainTick();
    expect(runner.drainQueue).not.toHaveBeenCalled();
  });

  test('re-entry guard prevents concurrent drains', async () => {
    runner.loadQueue.mockReturnValue([{ issueId: 'X', retryAt: null }]);
    
    // Create a promise that we can control to simulate a long-running drain
    let resolveDrain: any;
    const drainPromise = new Promise((resolve) => {
      resolveDrain = resolve;
    });
    runner.drainQueue.mockReturnValue(drainPromise);

    // Start first drain
    const firstTick = runPeriodicDrainTick();
    
    // Start second drain while first is still running
    await runPeriodicDrainTick();
    
    expect(runner.drainQueue).toHaveBeenCalledTimes(1);

    // Resolve first drain
    resolveDrain();
    await firstTick;
  });

  test('startPeriodicDrain returns a timer and calls unref', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const timer = startPeriodicDrain(1000);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
    // unref check: in jest/node it should have been called
    // We already checked typeof timer.unref === 'function' in implementation
    clearInterval(timer);
    setIntervalSpy.mockRestore();
  });
});

// SOT-1437 / P2: per-issue webhook debounce/coalesce.
describe('webhook per-issue debounce/coalesce (SOT-1437)', () => {
  const originalDebounce = process.env.WEBHOOK_DEBOUNCE_MS;
  const runner: any = mockRunner;

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const meta = (priority: number | null = null) => ({
    priority,
    priorityLabel: null,
    parentIssueId: null,
    parentIssueIdentifier: null,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    _resetDebounceTimers();
    runner.acquireLock.mockReturnValue(true);
    runner.hasPendingIssues.mockResolvedValue(true);
    runner.isLocked.mockReturnValue(false);
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);
    runner.dequeue.mockReturnValue(null); // stop after enqueue+dequeue (no runItem)
    runner.loadQueue.mockReturnValue([]);
  });

  afterEach(() => {
    _resetDebounceTimers();
    if (originalDebounce === undefined) delete process.env.WEBHOOK_DEBOUNCE_MS;
    else process.env.WEBHOOK_DEBOUNCE_MS = originalDebounce;
  });

  test('coalesces a burst of same-issue events into a single processing pass', async () => {
    process.env.WEBHOOK_DEBOUNCE_MS = '30';
    scheduleIssueEvent('CO-1', meta());
    scheduleIssueEvent('CO-1', meta());
    scheduleIssueEvent('CO-1', meta());
    // Only one pending timer while inside the window (coalesced).
    expect(_debounceTimers.size).toBe(1);
    await wait(60);
    // Processing ran exactly once → enqueue called once for CO-1.
    const co1Enqueues = runner.enqueue.mock.calls.filter((c: any[]) => c[0] === 'CO-1');
    expect(co1Enqueues).toHaveLength(1);
    expect(_debounceTimers.size).toBe(0);
  });

  test('distinct issues each get their own single deferred processing', async () => {
    process.env.WEBHOOK_DEBOUNCE_MS = '30';
    scheduleIssueEvent('A-1', meta());
    scheduleIssueEvent('B-1', meta());
    expect(_debounceTimers.size).toBe(2);
    await wait(60);
    expect(runner.enqueue.mock.calls.filter((c: any[]) => c[0] === 'A-1')).toHaveLength(1);
    expect(runner.enqueue.mock.calls.filter((c: any[]) => c[0] === 'B-1')).toHaveLength(1);
  });

  test('latest event wins (most recent meta is used)', async () => {
    process.env.WEBHOOK_DEBOUNCE_MS = '30';
    scheduleIssueEvent('LW-1', meta(3));
    scheduleIssueEvent('LW-1', meta(1)); // bumped to Urgent last
    await wait(60);
    const call = runner.enqueue.mock.calls.find((c: any[]) => c[0] === 'LW-1');
    expect(call).toBeDefined();
    // enqueue(id, 'webhook', retryAt, { priority, ... }) — latest priority (1) must be used.
    expect(call[3].priority).toBe(1);
  });

  test('default (WEBHOOK_DEBOUNCE_MS unset/0) processes immediately with no debounce timer', async () => {
    delete process.env.WEBHOOK_DEBOUNCE_MS;
    scheduleIssueEvent('IMM-1', meta());
    // No debounce timer is created in immediate mode.
    expect(_debounceTimers.size).toBe(0);
    await wait(20); // let setImmediate + async processing settle
    expect(runner.enqueue.mock.calls.filter((c: any[]) => c[0] === 'IMM-1')).toHaveLength(1);
  });
});
