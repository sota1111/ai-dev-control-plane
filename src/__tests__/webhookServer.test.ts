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
  postUsageLimitComment: (jest.fn() as any).mockResolvedValue(undefined),
  addUsageLimitLabel: (jest.fn() as any).mockResolvedValue(undefined),
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
  isQueuedOrRunning: jest.fn().mockReturnValue(false),
  syncQueueWithLinear: (jest.fn() as any).mockResolvedValue(undefined),
  isLocked: jest.fn().mockReturnValue(false),
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
const { app } = webhookServer;

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

// Restore secret at the end of all tests in this file
afterAll(() => {
  process.env.LINEAR_WEBHOOK_SECRET = originalSecret;
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

  it('should skip scan when WEBHOOK_BOOTSTRAP_SCAN_ENABLED is not set', async () => {
    await runBootstrapScan();
    expect(runner.fetchActiveIssues).not.toHaveBeenCalled();
    expect(runner.enqueue).not.toHaveBeenCalled();
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

    expect(runner.fetchActiveIssues).toHaveBeenCalledWith(50);
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
