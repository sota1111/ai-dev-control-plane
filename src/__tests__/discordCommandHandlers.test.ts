import { jest } from '@jest/globals';

const mockRunner = {
  isLocked: jest.fn().mockReturnValue(false),
  getCurrentIssue: jest.fn().mockReturnValue(null),
  fetchActiveIssues: (jest.fn() as any).mockResolvedValue([]),
  loadQueue: jest.fn().mockReturnValue([]),
  getUsageLimitCooldownUntil: jest.fn().mockReturnValue(null),
  linearQuery: jest.fn(),
  log: jest.fn(),
  LOG_DIR: '/tmp/test_logs',
  enqueue: jest.fn(),
  isQueued: jest.fn().mockReturnValue(false),
  drainQueue: (jest.fn() as any).mockResolvedValue(undefined),
  saveQueue: jest.fn(),
  getPriorityRank: jest.fn((p) => {
    if (p === 1) return 1;
    if (p === 2) return 2;
    if (p === 3) return 3;
    if (p === 4) return 4;
    return 5;
  }),
};

const mockPauseState = {
  isPaused: jest.fn().mockReturnValue(false),
  setPaused: jest.fn(),
  clearPause: jest.fn().mockReturnValue(true),
  getPauseInfo: jest.fn().mockReturnValue(null),
};

jest.unstable_mockModule('../runner.js', () => ({
  ...mockRunner,
  default: mockRunner,
}));

jest.unstable_mockModule('../lib/discordPauseState.js', () => ({
  ...mockPauseState,
  default: mockPauseState,
}));

const runner = await import('../runner.js');
const pauseState = await import('../lib/discordPauseState.js');
const handlers = await import('../lib/discordCommandHandlers.js');

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
    (runner.isLocked as any).mockReturnValueOnce(true);
    const result = await handlers.handleStatus();
    expect(result.content).toContain('実行中');
  });

  test('returns status with current issue and elapsed time', async () => {
    const startedAt = new Date(Date.now() - 3 * 60000 - 42000).toISOString(); // 3m 42s ago
    (runner.getCurrentIssue as any).mockReturnValueOnce({
      issueId: 'uuid',
      issueIdentifier: 'SOT-555',
      startedAt
    });
    const result = await handlers.handleStatus();
    expect(result.content).toContain('**実行中**: ▶ SOT-555 (経過 3m 42s)');
  });

  test('returns "none" when no issue is running', async () => {
    (runner.getCurrentIssue as any).mockReturnValueOnce(null);
    const result = await handlers.handleStatus();
    expect(result.content).toContain('**実行中**: なし');
  });
});

describe('handleQueue', () => {
  test('returns empty message for empty queue', async () => {
    (runner.loadQueue as any).mockReturnValueOnce([]);
    const result = await handlers.handleQueue();
    expect(result.content).toContain('空');
  });

  test('returns queue contents when items exist', async () => {
    (runner.loadQueue as any).mockReturnValueOnce([
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
    (runner.loadQueue as any).mockReturnValueOnce([
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
    (runner.loadQueue as any).mockReturnValueOnce([
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

  test('returns queue with current issue as item 0', async () => {
    (runner.getCurrentIssue as any).mockReturnValueOnce({
      issueId: 'uuid-777',
      issueIdentifier: 'SOT-777',
      startedAt: new Date().toISOString()
    });
    (runner.loadQueue as any).mockReturnValueOnce([]);
    const result = await handlers.handleQueue();
    expect(result.content).toContain('0. ▶ 現在実行中: **SOT-777**');
  });

  test('enriches queue items with title and url from fetchActiveIssues', async () => {
    (runner.fetchActiveIssues as any).mockResolvedValueOnce([
      {
        identifier: 'SOT-100',
        title: 'タイトルA',
        url: 'https://linear.app/x/SOT-100'
      }
    ]);
    (runner.loadQueue as any).mockReturnValueOnce([
      {
        issueId: 'uuid-100',
        issueIdentifier: 'SOT-100',
        trigger: 'webhook',
        enqueuedAt: new Date().toISOString(),
        priorityRank: 2
      }
    ]);
    const result = await handlers.handleQueue();
    expect(result.content).toContain('SOT-100');
    expect(result.content).toContain('タイトルA');
    expect(result.content).toContain('https://linear.app/x/SOT-100');
  });

  test('falls back to identifier only when fetchActiveIssues fails', async () => {
    (runner.fetchActiveIssues as any).mockRejectedValueOnce(new Error('API Error'));
    (runner.loadQueue as any).mockReturnValueOnce([
      {
        issueId: 'uuid-100',
        issueIdentifier: 'SOT-100',
        trigger: 'webhook',
        enqueuedAt: new Date().toISOString(),
        priorityRank: 2
      }
    ]);
    const result = await handlers.handleQueue();
    expect(result.content).toContain('SOT-100');
    // Should not crash
  });
});

describe('handlePause', () => {
  test('pauses when not already paused', async () => {
    (pauseState.isPaused as any).mockReturnValueOnce(false);
    const result = await handlers.handlePause();
    expect(pauseState.setPaused).toHaveBeenCalled();
    expect(result.content).toContain('一時停止');
  });

  test('returns already paused message when already paused', async () => {
    (pauseState.isPaused as any).mockReturnValueOnce(true);
    const result = await handlers.handlePause();
    expect(result.content).toContain('すでに一時停止');
  });
});

describe('handleResume', () => {
  test('resumes when paused', async () => {
    (pauseState.clearPause as any).mockReturnValueOnce(true);
    const result: any = await handlers.handleResume();
    expect(result.content).toContain('解除');
  });
});

describe('handleReply', () => {
  test('rejects invalid issue ID', async () => {
    const interaction = { data: { options: [{ name: 'issue', value: 'INVALID' }, { name: 'body', value: 'test' }] } };
    const result = await handlers.handleReply(interaction as any);
    expect(result.content).toContain('SOT-xxx');
  });

  test('rejects body over 1000 chars', async () => {
    const interaction = { data: { options: [{ name: 'issue', value: 'SOT-123' }, { name: 'body', value: 'x'.repeat(1001) }] } };
    const result = await handlers.handleReply(interaction as any);
    expect(result.content).toContain('長すぎ');
  });

  test('posts comment for valid input', async () => {
    (runner.linearQuery as any).mockResolvedValueOnce({ commentCreate: { success: true, comment: { id: 'cmt1' } } });
    const interaction = { data: { options: [{ name: 'issue', value: 'SOT-123' }, { name: 'body', value: 'テストコメント' }] } };
    const result = await handlers.handleReply(interaction as any);
    expect(result.content).toContain('✅');
  });
});

describe('handleRetry', () => {
  test('rejects invalid issue ID', async () => {
    const interaction = { data: { options: [{ name: 'issue', value: 'INVALID' }] } };
    const result = await handlers.handleRetry(interaction as any);
    expect(result.content).toContain('SOT-xxx');
  });

  test('enqueues valid issue and triggers drain', async () => {
    (runner.isQueued as any).mockReturnValueOnce(false);
    const interaction = { data: { options: [{ name: 'issue', value: 'SOT-123' }] } };
    const result = await handlers.handleRetry(interaction as any);
    expect(runner.enqueue).toHaveBeenCalledWith('SOT-123', 'discord-retry');
    expect(result.content).toContain('✅');
    expect(result.content).toContain('ドレインを開始します');

    // Wait for setImmediate
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(runner.drainQueue).toHaveBeenCalled();
  });
});

describe('handleReorder', () => {
  test('reorders active issues by priority', async () => {
    (runner.loadQueue as any).mockReturnValueOnce([]);
    (runner.fetchActiveIssues as any).mockResolvedValueOnce([
      { id: 'uuid-low', identifier: 'SOT-3', priority: 4, priorityLabel: 'Low' },
      { id: 'uuid-urgent', identifier: 'SOT-1', priority: 1, priorityLabel: 'Urgent' },
      { id: 'uuid-med', identifier: 'SOT-2', priority: 3, priorityLabel: 'Medium' },
    ]);

    const result = await handlers.handleReorder();
    expect(runner.saveQueue).toHaveBeenCalled();
    const saved = (runner.saveQueue as any).mock.calls[0][0];
    
    expect(saved[0].issueIdentifier).toBe('SOT-1');
    expect(saved[1].issueIdentifier).toBe('SOT-2');
    expect(saved[2].issueIdentifier).toBe('SOT-3');
    expect(result.content).toContain('**総件数**: 3 件');
  });

  test('preserves metadata for existing issues', async () => {
    const retryAt = new Date(Date.now() + 3600000).toISOString();
    (runner.loadQueue as any).mockReturnValueOnce([
      {
        issueId: 'uuid-active',
        issueIdentifier: 'SOT-ACTIVE',
        retryAt,
        queueGroup: 'group-1',
        enqueuedAt: '2026-06-18T00:00:00.000Z',
        attemptCount: 5
      }
    ]);
    (runner.fetchActiveIssues as any).mockResolvedValueOnce([
      { id: 'uuid-active', identifier: 'SOT-ACTIVE', priority: 2, priorityLabel: 'High' }
    ]);

    await handlers.handleReorder();
    const saved = (runner.saveQueue as any).mock.calls[0][0];
    
    expect(saved[0].issueId).toBe('uuid-active');
    expect(saved[0].retryAt).toBe(retryAt);
    expect(saved[0].queueGroup).toBe('group-1');
    expect(saved[0].attemptCount).toBe(5);
    expect(saved[0].priority).toBe(2);
    expect(saved[0].priorityLabel).toBe('High');
  });

  test('preserves non-active existing items at the end', async () => {
    (runner.loadQueue as any).mockReturnValueOnce([
      { issueId: 'uuid-stale', issueIdentifier: 'SOT-STALE', enqueuedAt: '2026-06-18T00:00:00.000Z' }
    ]);
    (runner.fetchActiveIssues as any).mockResolvedValueOnce([
      { id: 'uuid-active', identifier: 'SOT-ACTIVE', priority: 1, priorityLabel: 'Urgent' }
    ]);

    await handlers.handleReorder();
    const saved = (runner.saveQueue as any).mock.calls[0][0];
    
    expect(saved.length).toBe(2);
    expect(saved[0].issueId).toBe('uuid-active');
    expect(saved[1].issueId).toBe('uuid-stale');
  });

  test('returns error message when fetchActiveIssues fails', async () => {
    (runner.fetchActiveIssues as any).mockRejectedValueOnce(new Error('Linear Timeout'));
    const result = await handlers.handleReorder();
    expect(result.content).toContain('Linear Issueの取得に失敗しました');
  });
});
