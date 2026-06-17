import { jest } from '@jest/globals';

let DiscordNotifierMock: any;

const mockRunner: any = {
  SKIPPED_LOCKED: 75,
  log: jest.fn(),
  acquireLock: jest.fn().mockReturnValue(true),
  releaseLock: jest.fn(),
  hasPendingIssues: (jest.fn() as any).mockResolvedValue(true),
  setIssueInProgress: (jest.fn() as any).mockResolvedValue(undefined),
  notifyUsageLimitToAllActiveIssues: (jest.fn() as any).mockResolvedValue(undefined),
  removeUsageLimitLabel: (jest.fn() as any).mockResolvedValue(undefined),
  enqueue: jest.fn(),
  dequeue: jest.fn().mockReturnValue(null),
  isQueued: jest.fn().mockReturnValue(false),
  isLocked: jest.fn().mockReturnValue(false),
  loadQueue: jest.fn().mockReturnValue([]),
  LOG_DIR: '/tmp/test-logs',
};
const mockCp = { spawn: jest.fn(), execSync: jest.fn() };

jest.unstable_mockModule('../lib/discordNotifier.js', () => ({
  DiscordNotifier: DiscordNotifierMock,
}));
jest.unstable_mockModule('../runner.js', () => ({ ...mockRunner, default: mockRunner }));
jest.unstable_mockModule('node:child_process', () => ({ ...mockCp, default: mockCp }));

describe('DiscordNotifier integration in webhook-server', () => {
  const webhookUrl = 'https://discord.com/api/webhooks/test/hook';
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;
  let originalEnv: NodeJS.ProcessEnv;
  let originalListeners: Record<string, any[]>;

  async function loadWebhookServer() {
    await import('../webhook-server.js');
  }

  beforeEach(() => {
    jest.resetModules();

    originalEnv = { ...process.env };
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;
    originalListeners = {
      SIGTERM: process.listeners('SIGTERM'),
      SIGINT: process.listeners('SIGINT'),
      uncaughtException: process.listeners('uncaughtException'),
      unhandledRejection: process.listeners('unhandledRejection')
    };

    process.stdout.write = jest.fn(() => true) as any;
    process.stderr.write = jest.fn(() => true) as any;
    process.env.DISCORD_WEBHOOK_URL = webhookUrl;
    process.env.LINEAR_WEBHOOK_SECRET = 'test-secret';

    DiscordNotifierMock = jest.fn().mockImplementation(() => ({
      start: jest.fn(),
      stop: jest.fn(),
      add: jest.fn(),
      flush: (jest.fn() as any).mockResolvedValue(undefined)
    }));
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;

    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    for (const listener of originalListeners.SIGTERM) process.on('SIGTERM', listener);
    for (const listener of originalListeners.SIGINT) process.on('SIGINT', listener);
    for (const listener of originalListeners.uncaughtException) process.on('uncaughtException', listener);
    for (const listener of originalListeners.unhandledRejection) process.on('unhandledRejection', listener);

    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  test('DiscordNotifier is constructed with DISCORD_WEBHOOK_URL', async () => {
    await loadWebhookServer();

    expect(DiscordNotifierMock).toHaveBeenCalledWith(webhookUrl);
  });

  test('start() is called on DiscordNotifier instance', async () => {
    await loadWebhookServer();
    const instance = DiscordNotifierMock.mock.results[0].value;

    expect(instance.start).toHaveBeenCalled();
  });

  test('stdout and stderr writes are forwarded to notifier.add()', async () => {
    await loadWebhookServer();
    const instance = DiscordNotifierMock.mock.results[0].value;

    process.stdout.write('test stdout log message');
    process.stderr.write(Buffer.from('test stderr log message'));

    expect(instance.add).toHaveBeenCalledWith(expect.stringContaining('test stdout log message'));
    expect(instance.add).toHaveBeenCalledWith(expect.stringContaining('test stderr log message'));
  });
});
