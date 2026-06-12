const request = require('supertest');

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
    spawn.mockReset();
    // Default mock behavior: successful run
    spawn.mockImplementation(() => mockSpawnChild({ exitCode: 0 }));
    
    // Mock setTimeout to prevent long waits, but ALLOW it to run if we want
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
      if (ms <= 100) return originalSetTimeout(fn, ms); // allow mockSpawnChild and small waits
      return { unref: () => {} }; // block retry timeout
    });
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
    spawn.mockImplementationOnce(() => mockSpawnChild({
      stdout: "You've hit your session limit · resets 3:30pm (UTC)",
      exitCode: 1
    }));
    
    const res = await request(app).post('/webhooks/linear').send(issuePayload(id));
    expect(res.status).toBe(200);
    
    // Wait for the async triggerRun block to complete its first run
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    // Check that setTimeout was called with a large delay (the retry)
    const retryCall = setTimeout.mock.calls.find(call => call[1] > 1000);
    expect(retryCall).toBeDefined();

    // pendingRetryIssues should contain TEST-RETRY
    const res2 = await request(app).post('/webhooks/linear').send(issuePayload(id));
    expect(res2.body.status).toBe('ignored');
    expect(res2.body.reason).toMatch(/already processing or pending retry/);
  });

  test('does not retry when run_auto.sh fails without usage limit message', async () => {
    const id = 'TEST-NO-RETRY';
    spawn.mockImplementationOnce(() => mockSpawnChild({
      stdout: 'some random error',
      exitCode: 1
    }));
    
    await request(app).post('/webhooks/linear').send(issuePayload(id));
    
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    // No retry scheduled (no large timeout)
    const retryCall = setTimeout.mock.calls.find(call => call[1] > 1000);
    expect(retryCall).toBeUndefined();

    // Should be able to re-submit (not in pending)
    spawn.mockImplementationOnce(() => mockSpawnChild({ exitCode: 0 }));
    const res2 = await request(app).post('/webhooks/linear').send(issuePayload(id));
    expect(res2.body.status).toBe('accepted');
  });

  test('does not affect normal successful runs', async () => {
    const id = 'TEST-SUCCESS';
    spawn.mockImplementationOnce(() => mockSpawnChild({ exitCode: 0 }));
    
    await request(app).post('/webhooks/linear').send(issuePayload(id));
    
    await new Promise(resolve => originalSetTimeout(resolve, 50));

    const retryCall = setTimeout.mock.calls.find(call => call[1] > 1000);
    expect(retryCall).toBeUndefined();

    // After success, issue removed from runningIssues → second webhook accepted
    spawn.mockImplementationOnce(() => mockSpawnChild({ exitCode: 0 }));
    const res2 = await request(app).post('/webhooks/linear').send(issuePayload(id));
    expect(res2.body.status).toBe('accepted');
  });
});
