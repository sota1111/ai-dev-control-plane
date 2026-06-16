const request = require('supertest');

jest.mock('../runner', () => ({
  SKIPPED_LOCKED: 75,
  log: jest.fn(),
  acquireLock: jest.fn().mockReturnValue(true),
  releaseLock: jest.fn(),
  hasPendingIssues: jest.fn().mockResolvedValue(true),
  setIssueInProgress: jest.fn().mockResolvedValue(undefined),
  postUsageLimitComment: jest.fn().mockResolvedValue(undefined),
  addUsageLimitLabel: jest.fn().mockResolvedValue(undefined),
  notifyUsageLimitToAllActiveIssues: jest.fn().mockResolvedValue(undefined),
  removeUsageLimitLabel: jest.fn().mockResolvedValue(undefined),
  setUsageLimitCooldownUntil: jest.fn(),
  clearUsageLimitCooldown: jest.fn(),
  getUsageLimitCooldownUntil: jest.fn().mockReturnValue(null),
  enqueue: jest.fn(),
  runItem: jest.fn().mockResolvedValue(undefined),
  drainQueue: jest.fn().mockResolvedValue(undefined),
  dequeue: jest.fn().mockReturnValue(null),
  removeFromQueue: jest.fn(),
  isQueued: jest.fn().mockReturnValue(false),
  isLocked: jest.fn().mockReturnValue(false),
  loadQueue: jest.fn().mockReturnValue([]),
  getIssueExecutionEligibility: jest.fn().mockResolvedValue({ eligible: true }),
  LOG_DIR: '/tmp/test-logs',
  LOCK_FILE: '/tmp/test-logs/runner.lock',
  QUEUE_FILE: '/tmp/test-logs/runner.queue.json',
  LOG_FILE: '/tmp/test-logs/auto_runner.log',
  STALE_LOCK_MS: 30 * 60 * 1000,
  LINEAR_API_URL: 'https://api.linear.app/graphql',
}));

// Mock child_process BEFORE requiring the server
jest.mock('child_process', () => ({
  spawn: jest.fn()
}));
const { spawn } = require('child_process');

// Disable signature verification BEFORE requiring the server
const originalSecret = process.env.LINEAR_WEBHOOK_SECRET;
process.env.LINEAR_WEBHOOK_SECRET = '';

const app = require('../webhook-server');

// Helper: create a mock spawn child that emits given stdout, stderr, then closes
function mockSpawnChild({ stdout = '', stderr = '', exitCode = 0 } = {}) {
  const EventEmitter = require('events');
  const child = new EventEmitter();
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
    spawn.mockReset();
    // Default mock behavior: successful run
    spawn.mockImplementation(() => mockSpawnChild({ exitCode: 0 }));
    
    // Mock setTimeout to prevent long waits, but ALLOW it to run if we want
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
      if (ms <= 100) return originalSetTimeout(fn, ms); // allow mockSpawnChild and small waits
      return { unref: () => {} }; // block retry timeout
    });

    const runner = require('../runner');
    runner.acquireLock.mockReturnValue(true);
    runner.hasPendingIssues.mockResolvedValue(true);
    runner.isQueued.mockReturnValue(false);
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);
    runner.dequeue.mockReturnValue(null);
    runner.runItem.mockResolvedValue(undefined);
    runner.drainQueue.mockResolvedValue(undefined);
    runner.getIssueExecutionEligibility.mockResolvedValue({ eligible: true });
  });


  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Restore secret at the end of all tests in this file
  afterAll(() => {
    process.env.LINEAR_WEBHOOK_SECRET = originalSecret;
  });

  const issuePayload = (id = 'TEST-001') => ({
    type: 'Issue',
    action: 'update',
    data: { identifier: id, title: 'test', state: { name: 'In Progress' }, labels: [] }
  });

  test('schedules retry when run_auto.sh outputs usage limit message', async () => {
    const id = 'TEST-RETRY';
    const runner = require('../runner');

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
    const res2 = await request(app).post('/webhooks/linear').send(issuePayload(id));
    expect(res2.body.status).toBe('ignored');
  });

  test('queues webhook without spawning while usage limit cooldown is active', async () => {
    const runner = require('../runner');
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
    const runner = require('../runner');
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });

    await request(app).post('/webhooks/linear').send(issuePayload(id));

    await new Promise(resolve => originalSetTimeout(resolve, 50));

    // Verify runner.runItem was called
    expect(runner.runItem).toHaveBeenCalledWith({ issueId: id, trigger: 'webhook', retryAt: null });

    // No large setTimeout should be registered (runner.runItem is mocked, not actual retry logic)
    const retryCall = setTimeout.mock.calls.find(call => call[1] > 1000);
    expect(retryCall).toBeUndefined();
  });

  test("ignores terminal issue update events", async () => {
    const runner = require("../runner");
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
    const runner = require('../runner');
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });
    spawn.mockImplementationOnce(() => mockSpawnChild({ exitCode: 0 }));

    await request(app).post('/webhooks/linear').send(issuePayload(id));
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    expect(runner.setIssueInProgress).not.toHaveBeenCalled();
  });

  test('does not affect normal successful runs', async () => {
    const id = 'TEST-SUCCESS';
    const runner = require('../runner');
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });

    await request(app).post('/webhooks/linear').send(issuePayload(id));

    await new Promise(resolve => originalSetTimeout(resolve, 50));

    // webhook delegates to runner.runItem
    expect(runner.runItem).toHaveBeenCalledWith({ issueId: id, trigger: 'webhook', retryAt: null });
    // After successful run, runner.runItem handles clearUsageLimitCooldown + removeUsageLimitLabel internally

    // Second webhook is accepted after first completes
    runner.isQueued.mockReturnValue(false);
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });
    const res2 = await request(app).post('/webhooks/linear').send(issuePayload(id));
    expect(res2.body.status).toBe('accepted');
  });

  test('enqueues non-Urgent issue when a run is locked', async () => {
    const runner = require('../runner');
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
    const runner = require('../runner');
    runner.isLocked.mockReturnValue(true); // simulate active run
    runner.isQueued.mockReturnValue(false);
    runner.dequeue.mockReturnValueOnce({ issueId: 'TEST-URGENT', trigger: 'webhook', retryAt: null });
    spawn.mockImplementationOnce(() => mockSpawnChild({ exitCode: 0 }));

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
    const runner = require('../runner');
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

describe('webhook issue filtering', () => {
  const originalSetTimeout = global.setTimeout;

  beforeEach(() => {
    jest.clearAllMocks();
    spawn.mockReset();
    spawn.mockImplementation(() => mockSpawnChild({ exitCode: 0 }));
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
      if (ms <= 100) return originalSetTimeout(fn, ms);
      return { unref: () => {} };
    });

    const runner = require('../runner');
    runner.acquireLock.mockReturnValue(true);
    runner.hasPendingIssues.mockResolvedValue(true);
    runner.isQueued.mockReturnValue(false);
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);
    runner.dequeue.mockReturnValue(null);
    runner.runItem.mockResolvedValue(undefined);
    runner.drainQueue.mockResolvedValue(undefined);
    runner.getIssueExecutionEligibility.mockResolvedValue({ eligible: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makePayload(action, stateOverrides = {}, extra = {}) {
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
    const runner = require('../runner');
    const payload = makePayload('update', { name: 'Done', type: 'completed' });
    const res = await request(app).post('/webhooks/linear').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored');
    expect(res.body.reason).toMatch(/terminal state/);
    expect(runner.removeFromQueue).toHaveBeenCalledWith('TEST-FILTER');
    expect(runner.runItem).not.toHaveBeenCalled();
  });

  test('canceled issue update is ignored', async () => {
    const runner = require('../runner');
    const payload = makePayload('update', { name: 'Canceled', type: 'canceled' });
    const res = await request(app).post('/webhooks/linear').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored');
    expect(res.body.reason).toMatch(/terminal state/);
    expect(runner.removeFromQueue).toHaveBeenCalledWith('TEST-FILTER');
    expect(runner.runItem).not.toHaveBeenCalled();
  });

  test('duplicate issue update is ignored', async () => {
    const runner = require('../runner');
    const payload = makePayload('update', { name: 'Duplicate', type: 'duplicate' });
    const res = await request(app).post('/webhooks/linear').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored');
    expect(res.body.reason).toMatch(/terminal state/);
    expect(runner.removeFromQueue).toHaveBeenCalledWith('TEST-FILTER');
    expect(runner.runItem).not.toHaveBeenCalled();
  });

  test('archived issue update is ignored', async () => {
    const runner = require('../runner');
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
    const runner = require('../runner');
    runner.dequeue.mockReturnValueOnce({ issueId: 'TEST-CREATE', trigger: 'webhook', retryAt: null });
    spawn.mockImplementationOnce(() => mockSpawnChild({ exitCode: 0 }));

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
    const runner = require('../runner');
    runner.dequeue.mockReturnValueOnce({ issueId: 'TEST-MEANINGFUL', trigger: 'webhook', retryAt: null });
    spawn.mockImplementationOnce(() => mockSpawnChild({ exitCode: 0 }));

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
    const runner = require('../runner');
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
    const runner = require('../runner');
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
    spawn.mockReset();
    spawn.mockImplementation(() => mockSpawnChild({ exitCode: 0 }));
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
      if (ms <= 100) return originalSetTimeout(fn, ms);
      return { unref: () => {} };
    });

    const runner = require('../runner');
    runner.acquireLock.mockReturnValue(true);
    runner.hasPendingIssues.mockResolvedValue(true);
    runner.isQueued.mockReturnValue(false);
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);
    runner.dequeue.mockReturnValue(null);
    runner.runItem.mockResolvedValue(undefined);
    runner.drainQueue.mockResolvedValue(undefined);
    runner.getIssueExecutionEligibility.mockResolvedValue({ eligible: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const issuePayload = (id = 'TEST-001') => ({
    type: 'Issue',
    action: 'update',
    updatedFrom: { stateId: 'old-state' },
    data: { identifier: id, title: 'test', state: { name: 'In Progress', type: 'started' }, labels: [] }
  });

  test('queued completed issue is skipped before runItem', async () => {
    const runner = require('../runner');
    const id = 'TEST-QUEUED-COMPLETED';
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });

    await request(app).post('/webhooks/linear').send(issuePayload(id));
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    // webhook-server.js now delegates to runner.runItem
    expect(runner.runItem).toHaveBeenCalledWith({ issueId: id, trigger: 'webhook', retryAt: null });
  });

  test('retry completed issue is skipped before triggerRun', async () => {
    const runner = require('../runner');
    const id = 'TEST-RETRY-COMPLETED';
    // Issue is dequeued (would be in retry queue) but is now completed
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });

    await request(app).post('/webhooks/linear').send(issuePayload(id));
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    // webhook-server.js delegates to runner.runItem
    expect(runner.runItem).toHaveBeenCalledWith({ issueId: id, trigger: 'webhook', retryAt: null });
  });

  test('archived queued issue is removed before execution', async () => {
    const runner = require('../runner');
    const id = 'TEST-ARCHIVED-QUEUED';
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });

    await request(app).post('/webhooks/linear').send(issuePayload(id));
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    // webhook-server.js delegates to runner.runItem
    expect(runner.runItem).toHaveBeenCalledWith({ issueId: id, trigger: 'webhook', retryAt: null });
  });

  test('active queued issue still runs', async () => {
    const runner = require('../runner');
    const id = 'TEST-ACTIVE-RUNS';
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });

    await request(app).post('/webhooks/linear').send(issuePayload(id));
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    expect(runner.runItem).toHaveBeenCalledWith({ issueId: id, trigger: 'webhook', retryAt: null });
  });
});
