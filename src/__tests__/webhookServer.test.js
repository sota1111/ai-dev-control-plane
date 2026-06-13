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
  enqueue: jest.fn(),
  dequeue: jest.fn().mockReturnValue(null),
  removeFromQueue: jest.fn(),
  isQueued: jest.fn().mockReturnValue(false),
  isLocked: jest.fn().mockReturnValue(false),
  loadQueue: jest.fn().mockReturnValue([]),
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
    runner.dequeue.mockReturnValue(null);
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
    
    // dequeue が一度だけ this issue を返す
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });
    
    spawn.mockImplementationOnce(() => mockSpawnChild({
      stdout: "You've hit your session limit · resets 3:30pm (UTC)",
      exitCode: 1
    }));
    
    const res = await request(app).post('/webhooks/linear').send(issuePayload(id));
    expect(res.status).toBe(200);
    
    // Wait for the async triggerRun block to complete its first run
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    // runner.enqueue が retryAt 付きで呼ばれたことを確認
    expect(runner.enqueue).toHaveBeenCalledWith(id, 'webhook', expect.any(String));
    expect(runner.notifyUsageLimitToAllActiveIssues).toHaveBeenCalled();

    // 同じ issueId が再度 webhook で来た場合、isQueued=true で ignored
    runner.isQueued.mockReturnValue(true);
    const res2 = await request(app).post('/webhooks/linear').send(issuePayload(id));
    expect(res2.body.status).toBe('ignored');
  });

  test('does not retry when run_auto.sh fails without usage limit message', async () => {
    const id = 'TEST-NO-RETRY';
    const runner = require('../runner');
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });
    
    spawn.mockImplementationOnce(() => mockSpawnChild({
      stdout: 'some random error',
      exitCode: 1
    }));
    
    await request(app).post('/webhooks/linear').send(issuePayload(id));
    
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    // No retry scheduled (no large timeout)
    const retryCall = setTimeout.mock.calls.find(call => call[1] > 1000);
    expect(retryCall).toBeUndefined();

    // runner.enqueue should NOT have been called with a retryAt
    const enqueueCallsWithRetryAt = runner.enqueue.mock.calls.filter(call => call[2] != null);
    expect(enqueueCallsWithRetryAt).toHaveLength(0);

    // Should be able to re-submit (not in pending)
    runner.isQueued.mockReturnValue(false);
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });
    spawn.mockImplementationOnce(() => mockSpawnChild({ exitCode: 0 }));
    const res2 = await request(app).post('/webhooks/linear').send(issuePayload(id));
    expect(res2.body.status).toBe('accepted');
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
    expect(spawn).not.toHaveBeenCalled();
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
    
    spawn.mockImplementationOnce(() => mockSpawnChild({ exitCode: 0 }));
    
    await request(app).post('/webhooks/linear').send(issuePayload(id));
    
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    const retryCall = setTimeout.mock.calls.find(call => call[1] > 1000);
    expect(retryCall).toBeUndefined();

    // After success, removeUsageLimitLabel should be called
    expect(runner.removeUsageLimitLabel).toHaveBeenCalledWith(id);

    // After success, issue removed from runningIssues → second webhook accepted
    runner.isQueued.mockReturnValue(false);
    runner.dequeue.mockReturnValueOnce({ issueId: id, trigger: 'webhook', retryAt: null });
    spawn.mockImplementationOnce(() => mockSpawnChild({ exitCode: 0 }));
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
    expect(runner.enqueue).toHaveBeenCalledWith('TEST-NON-URGENT', 'webhook');
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
    expect(runner.enqueue).toHaveBeenCalledWith('TEST-URGENT', 'webhook');
  });

  test('drains queue after main task completes', async () => {
    const runner = require('../runner');
    runner.isLocked.mockReturnValue(false);
    runner.isQueued.mockReturnValue(false);

    // Initial issue
    const id1 = 'TEST-MAIN';
    // Queued issue to be drained
    const id2 = 'TEST-DRAIN';

    // Mock dequeue sequence:
    // 1. First dequeue for the main task
    // 2. Second dequeue during drain
    // 3. Third dequeue returns null to end drain
    runner.dequeue
      .mockReturnValueOnce({ issueId: id1, trigger: 'webhook' })
      .mockReturnValueOnce({ issueId: id2, trigger: 'webhook' })
      .mockReturnValue(null);

    // Mock loadQueue to show one item remains after id1 is dequeued
    runner.loadQueue
      .mockReturnValueOnce([{ issueId: id2 }]) // called after id1 run finishes
      .mockReturnValue([]); // called after id2 run finishes

    spawn.mockImplementation(() => mockSpawnChild({ exitCode: 0 }));

    await request(app).post('/webhooks/linear').send(issuePayload(id1));

    // Wait for main task and drain loop
    await new Promise(resolve => originalSetTimeout(resolve, 100));

    // Verify both were "run" (spawn called twice)
    expect(spawn).toHaveBeenCalledTimes(2);
    
    // Verify first spawn was for id1
    expect(spawn.mock.calls[0][0]).toBe('bash');
    // We can't easily check env in spawn mock calls without more setup, 
    // but we can check the runner logs if we wanted. 
    // Here, just confirming it triggered twice is a good signal for drain.

    // Verify lock was acquired and released for both
    expect(runner.acquireLock).toHaveBeenCalledTimes(2);
    expect(runner.releaseLock).toHaveBeenCalledTimes(2);
  });
});
