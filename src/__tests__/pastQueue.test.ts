import { jest } from '@jest/globals';

// /pastqueue handler tests. Mock the runner module so we control loadQueueHistory
// and fetchActiveIssues; queueOrdering is used for real (effectiveRank).
const mockRunner = {
  loadQueueHistory: jest.fn().mockReturnValue([] as any[]),
  fetchActiveIssues: (jest.fn() as any).mockResolvedValue([]),
  getCurrentIssue: jest.fn().mockReturnValue(null),
  loadQueue: jest.fn().mockReturnValue([]),
  log: jest.fn(),
  LOG_DIR: '/tmp/test_logs',
};

jest.unstable_mockModule('../runner.js', () => ({
  ...mockRunner,
  default: mockRunner,
}));

const handlers = await import('../lib/discordCommandHandlers.js');

function makeHistoryItem(overrides: Record<string, any> = {}) {
  return {
    issueId: 'uuid-' + (overrides.issueIdentifier || 'x'),
    issueIdentifier: 'SOT-100',
    trigger: 'webhook',
    retryAt: null,
    enqueuedAt: '2026-06-19T00:00:00.000Z',
    lastAttemptAt: null,
    attemptCount: 0,
    reason: null,
    priority: 2,
    priorityLabel: 'High',
    priorityRank: 2,
    linearFetchedAt: null,
    parentIssueId: null,
    parentIssueIdentifier: null,
    queueGroup: null,
    queueGroupOrder: null,
    dequeuedAt: '2026-06-19T01:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (mockRunner.fetchActiveIssues as any).mockResolvedValue([]);
});

describe('handlePastQueue', () => {
  test('returns the empty-history message when there is no history', async () => {
    (mockRunner.loadQueueHistory as any).mockReturnValueOnce([]);
    const result = await handlers.handlePastQueue();
    expect(result.content).toContain('過去キュー');
    expect(result.content).toContain('履歴がありません');
  });

  test('renders rows in the same format as /queue', async () => {
    (mockRunner.loadQueueHistory as any).mockReturnValueOnce([
      makeHistoryItem({ issueIdentifier: 'SOT-201', priorityLabel: 'High' }),
      makeHistoryItem({ issueIdentifier: 'SOT-202', priorityLabel: 'Medium' }),
    ]);
    const result = await handlers.handlePastQueue();
    expect(result.content).toContain('## 過去キュー (直近2件)');
    expect(result.content).toContain('1. **SOT-201** [High]');
    expect(result.content).toContain('2. **SOT-202** [Medium]');
    expect(result.content).toContain('— webhook');
  });

  test('caps the display at the most recent 10 entries', async () => {
    const items = Array.from({ length: 15 }, (_, i) =>
      makeHistoryItem({ issueIdentifier: `SOT-${300 + i}`, issueId: `uuid-${i}` }),
    );
    (mockRunner.loadQueueHistory as any).mockReturnValueOnce(items);
    const result = await handlers.handlePastQueue();
    expect(result.content).toContain('## 過去キュー (直近10件)');
    expect(result.content).toContain('SOT-300'); // first (newest)
    expect(result.content).toContain('10. **SOT-309**');
    expect(result.content).not.toContain('SOT-310'); // 11th, excluded
  });

  test('enriches with title/url when the issue is still active', async () => {
    (mockRunner.loadQueueHistory as any).mockReturnValueOnce([
      makeHistoryItem({ issueIdentifier: 'SOT-400' }),
    ]);
    (mockRunner.fetchActiveIssues as any).mockResolvedValueOnce([
      { identifier: 'SOT-400', title: 'Still active', url: 'https://linear.app/x/SOT-400' },
    ]);
    const result = await handlers.handlePastQueue();
    expect(result.content).toContain('Still active');
    expect(result.content).toContain('https://linear.app/x/SOT-400');
  });

  test('tolerates fetchActiveIssues failure', async () => {
    (mockRunner.loadQueueHistory as any).mockReturnValueOnce([
      makeHistoryItem({ issueIdentifier: 'SOT-500' }),
    ]);
    (mockRunner.fetchActiveIssues as any).mockRejectedValueOnce(new Error('network down'));
    const result = await handlers.handlePastQueue();
    expect(result.content).toContain('SOT-500');
  });
});
