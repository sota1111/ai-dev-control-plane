'use strict';

jest.mock('../runner', () => ({
  isLocked: jest.fn().mockReturnValue(false),
  loadQueue: jest.fn().mockReturnValue([]),
  getUsageLimitCooldownUntil: jest.fn().mockReturnValue(null),
  linearQuery: jest.fn(),
  log: jest.fn(),
  LOG_DIR: '/tmp/test_logs',
  enqueue: jest.fn(),
  isQueued: jest.fn().mockReturnValue(false),
  drainQueue: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/discordPauseState', () => ({
  isPaused: jest.fn().mockReturnValue(false),
  setPaused: jest.fn(),
  clearPause: jest.fn().mockReturnValue(true),
  getPauseInfo: jest.fn().mockReturnValue(null),
}));

const runner = require('../runner');
const pauseState = require('../lib/discordPauseState');
const handlers = require('../lib/discordCommandHandlers');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('handleStatus', () => {
  test('returns status string when not locked', async () => {
    const result = await handlers.handleStatus();
    expect(result.content).toContain('実行状態');
    expect(result.content).toContain('ロック');
  });

  test('returns status with lock indicator when locked', async () => {
    runner.isLocked.mockReturnValueOnce(true);
    const result = await handlers.handleStatus();
    expect(result.content).toContain('実行中');
  });
});

describe('handleQueue', () => {
  test('returns empty message for empty queue', async () => {
    runner.loadQueue.mockReturnValueOnce([]);
    const result = await handlers.handleQueue();
    expect(result.content).toContain('空');
  });

  test('returns queue contents when items exist', async () => {
    runner.loadQueue.mockReturnValueOnce([
      {
        issueId: 'SOT-100',
        trigger: 'webhook',
        enqueuedAt: new Date().toISOString(),
        priority: 2,
        priorityLabel: 'High',
        priorityRank: 2
      },
    ]);
    const result = await handlers.handleQueue();
    expect(result.content).toContain('SOT-100');
    expect(result.content).toContain('[High]');
    expect(result.content).toContain('(rank 2)');
  });

  test('orders issues by real execution priority in queue output', async () => {
    runner.loadQueue.mockReturnValueOnce([
      {
        issueId: 'parent-uuid',
        issueIdentifier: 'SOT-200',
        trigger: 'webhook',
        enqueuedAt: '2026-06-16T00:00:00.000Z',
        priorityLabel: 'Medium',
        priorityRank: 3
      },
      {
        issueId: 'unrelated-uuid',
        issueIdentifier: 'SOT-300',
        trigger: 'webhook',
        enqueuedAt: '2026-06-16T00:01:00.000Z',
        priorityLabel: 'High',
        priorityRank: 2
      },
      {
        issueId: 'child-uuid',
        issueIdentifier: 'SOT-201',
        trigger: 'webhook',
        enqueuedAt: '2026-06-16T00:02:00.000Z',
        priorityLabel: 'Low',
        priorityRank: 4,
        parentIssueId: 'parent-uuid',
        parentIssueIdentifier: 'SOT-200',
        queueGroup: 'parent-uuid'
      },
    ]);

    const result = await handlers.handleQueue();
    // Execution order: SOT-300 (rank 2) -> SOT-200 (rank 3) -> SOT-201 (rank 4, group continuation)
    expect(result.content).toContain('### 実行待ち (Ready)');
    const unrelatedIndex = result.content.indexOf('1. **SOT-300** [High] (rank 2)');
    const parentIndex = result.content.indexOf('2. **SOT-200** [Medium] (rank 3)');
    const childIndex = result.content.indexOf('3. **SOT-201** [Low] (rank 4)');

    expect(unrelatedIndex).toBeGreaterThan(0);
    expect(parentIndex).toBeGreaterThan(unrelatedIndex);
    expect(childIndex).toBeGreaterThan(parentIndex);
    expect(result.content).toContain('親: SOT-200');
  });

  test('separates waiting items in queue output', async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600000).toISOString();
    runner.loadQueue.mockReturnValueOnce([
      {
        issueId: 'ready-1',
        priorityRank: 3,
        enqueuedAt: now.toISOString()
      },
      {
        issueId: 'waiting-1',
        priorityRank: 1, // Urgent but waiting
        retryAt: future,
        enqueuedAt: now.toISOString()
      },
    ]);

    const result = await handlers.handleQueue();
    expect(result.content).toContain('### 実行待ち (Ready)');
    expect(result.content).toContain('1. **ready-1**');
    expect(result.content).toContain('### 待機中 (Waiting)');
    expect(result.content).toContain('1. **waiting-1**');
  });
});

describe('handlePause', () => {
  test('pauses when not already paused', async () => {
    pauseState.isPaused.mockReturnValueOnce(false);
    const result = await handlers.handlePause();
    expect(pauseState.setPaused).toHaveBeenCalled();
    expect(result.content).toContain('一時停止');
  });

  test('returns already paused message when already paused', async () => {
    pauseState.isPaused.mockReturnValueOnce(true);
    const result = await handlers.handlePause();
    expect(result.content).toContain('すでに一時停止');
  });
});

describe('handleResume', () => {
  test('resumes when paused', async () => {
    pauseState.clearPause.mockReturnValueOnce(true);
    const result = await handlers.handleResume();
    expect(result.content).toContain('解除');
  });
});

describe('handleReply', () => {
  test('rejects invalid issue ID', async () => {
    const interaction = { data: { options: [{ name: 'issue', value: 'INVALID' }, { name: 'body', value: 'test' }] } };
    const result = await handlers.handleReply(interaction);
    expect(result.content).toContain('SOT-xxx');
  });

  test('rejects body over 1000 chars', async () => {
    const interaction = { data: { options: [{ name: 'issue', value: 'SOT-123' }, { name: 'body', value: 'x'.repeat(1001) }] } };
    const result = await handlers.handleReply(interaction);
    expect(result.content).toContain('長すぎ');
  });

  test('posts comment for valid input', async () => {
    runner.linearQuery.mockResolvedValueOnce({ commentCreate: { success: true, comment: { id: 'cmt1' } } });
    const interaction = { data: { options: [{ name: 'issue', value: 'SOT-123' }, { name: 'body', value: 'テストコメント' }] } };
    const result = await handlers.handleReply(interaction);
    expect(result.content).toContain('✅');
  });
});

describe('handleRetry', () => {
  test('rejects invalid issue ID', async () => {
    const interaction = { data: { options: [{ name: 'issue', value: 'INVALID' }] } };
    const result = await handlers.handleRetry(interaction);
    expect(result.content).toContain('SOT-xxx');
  });

  test('enqueues valid issue and triggers drain', async () => {
    runner.isQueued.mockReturnValueOnce(false);
    const interaction = { data: { options: [{ name: 'issue', value: 'SOT-123' }] } };
    const result = await handlers.handleRetry(interaction);
    expect(runner.enqueue).toHaveBeenCalledWith('SOT-123', 'discord-retry');
    expect(result.content).toContain('✅');
    expect(result.content).toContain('ドレインを開始します');

    // Wait for setImmediate
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(runner.drainQueue).toHaveBeenCalled();
  });
});
