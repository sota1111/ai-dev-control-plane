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
      { issueId: 'SOT-100', trigger: 'webhook', enqueuedAt: new Date().toISOString() },
    ]);
    const result = await handlers.handleQueue();
    expect(result.content).toContain('SOT-100');
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

  test('enqueues valid issue', async () => {
    runner.isQueued.mockReturnValueOnce(false);
    const interaction = { data: { options: [{ name: 'issue', value: 'SOT-123' }] } };
    const result = await handlers.handleRetry(interaction);
    expect(runner.enqueue).toHaveBeenCalledWith('SOT-123', 'discord-retry');
    expect(result.content).toContain('✅');
  });
});
