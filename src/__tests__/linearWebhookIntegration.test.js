import { jest } from '@jest/globals';

const mockHttps = {
  request: jest.fn(),
};

const mockFs = {
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  appendFileSync: jest.fn(),
  renameSync: jest.fn(),
};

const mockChildProcess = {
  spawn: jest.fn(),
  execSync: jest.fn(),
};

jest.unstable_mockModule('node:https', () => ({
  default: mockHttps,
  ...mockHttps,
}));

jest.unstable_mockModule('node:fs', () => ({
  default: mockFs,
  ...mockFs,
}));

jest.unstable_mockModule('node:child_process', () => ({
  default: mockChildProcess,
  ...mockChildProcess,
}));

// Set env var BEFORE importing the app to skip signature verification
process.env.LINEAR_WEBHOOK_SECRET = '';

const request = (await import('supertest')).default;
const https = await import('node:https');
const fs = await import('node:fs');
const { spawn } = await import('node:child_process');
const { app } = await import('../webhook-server.js');
const { installLinearHttpMock } = await import('../__test_helpers__/linearMock.js');
const runner = await import('../runner.js');

describe('Linear Webhook Integration', () => {
  let linearMock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LINEAR_API_KEY = 'test-api-key';
    process.env.LINEAR_WEBHOOK_SECRET = ''; // Development mode: skip signature
    linearMock = installLinearHttpMock();

    // Mock fs
    let queueContent = '[]';
    fs.existsSync.mockImplementation((path) => {
      if (typeof path === 'string' && path.includes('runner.lock')) return false;
      return true;
    });
    fs.readFileSync.mockImplementation((path) => {
      if (typeof path === 'string' && path.includes('runner.queue.json')) return queueContent;
      return '{}';
    });
    fs.writeFileSync.mockImplementation((path, content) => {
      if (typeof path === 'string' && path.includes('runner.queue.json')) queueContent = content;
    });
    fs.mkdirSync.mockReturnValue(undefined);
    fs.appendFileSync.mockReturnValue(undefined);
    fs.renameSync.mockImplementation((src, dest) => {
      if (typeof dest === 'string' && dest.includes('runner.queue.json')) {
        // Find the tmp file content in writeFileSync calls
        const lastWrite = fs.writeFileSync.mock.calls.reverse().find(call => typeof call[0] === 'string' && call[0].includes('runner.queue.json.tmp'));
        if (lastWrite) queueContent = lastWrite[1];
      }
    });

    // Mock spawn to return a fake child process
    const mockChild = {
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn((event, cb) => {
        if (event === 'close') setTimeout(() => cb(0), 10);
      }),
      pid: 1234
    };
    spawn.mockReturnValue(mockChild);
  });

  afterEach(() => {
    linearMock.restore();
  });

  it('handles Linear Issue update webhook and triggers runner', async () => {
    const webhookBody = {
      type: 'Issue',
      action: 'update',
      data: {
        id: 'uuid-123',
        identifier: 'ENG-1',
        state: { name: 'Todo', type: 'unstarted' },
        priority: 2
      },
      updatedFrom: {
        title: 'Old Title'
      }
    };

    // Runner will call:
    // 1. hasPendingIssues (query { issues(...) })
    // 2. refreshQueuePriorities -> fetchActiveIssues (query { issues(...) })
    // 3. runItem -> getIssueExecutionEligibility (query { issue(...) })
    // 4. runItem -> triggerRun (spawn)
    // 5. runItem -> verifyTaskCompletion (query { issue(...) })

    linearMock.enqueue({ data: { issues: { nodes: [{ id: 'uuid-123' }] } } }); // hasPendingIssues
    linearMock.enqueue({ data: { issues: { nodes: [{ id: 'uuid-123', identifier: 'ENG-1', priority: 2, priorityLabel: 'High', state: { type: 'unstarted', name: 'Todo' } }] } } }); // refreshQueuePriorities -> fetchActiveIssues
    linearMock.enqueue({ data: { issue: { id: 'uuid-123', identifier: 'ENG-1', state: { name: 'Todo', type: 'unstarted' } } } }); // eligibility
    linearMock.enqueue({ data: { issue: { project: { name: 'ai-dev-control-plane' } } } }); // buildRunEnv -> project resolution
    linearMock.enqueue({ data: { issue: { id: 'uuid-123', state: { name: 'Done', type: 'completed' } } } }); // verifyTaskCompletion

    const response = await request(app)
      .post('/webhooks/linear')
      .send(webhookBody);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('accepted');

    // Wait for setImmediate and async runner flow
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify GraphQL calls
    expect(linearMock.calls.length).toBeGreaterThanOrEqual(3);
    
    // Verify spawn was called
    expect(spawn).toHaveBeenCalledWith(
      'bash',
      ['scripts/ai/run_auto.sh'],
      expect.objectContaining({
        env: expect.objectContaining({ WEBHOOK_ISSUE_ID: 'ENG-1' })
      })
    );
  });
});
