describe('DiscordNotifier integration in webhook-server', () => {
  const webhookUrl = 'https://discord.com/api/webhooks/test/hook';
  let DiscordNotifierMock;
  let originalStdoutWrite;
  let originalStderrWrite;
  let originalEnv;
  let originalListeners;

  function loadWebhookServer() {
    jest.isolateModules(() => {
      require('../webhook-server');
    });
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

    process.stdout.write = jest.fn(() => true);
    process.stderr.write = jest.fn(() => true);
    process.env.DISCORD_WEBHOOK_URL = webhookUrl;
    process.env.LINEAR_WEBHOOK_SECRET = 'test-secret';

    DiscordNotifierMock = jest.fn().mockImplementation(() => ({
      start: jest.fn(),
      stop: jest.fn(),
      add: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined)
    }));

    jest.doMock('../lib/discordNotifier', () => ({
      DiscordNotifier: DiscordNotifierMock
    }));

    jest.doMock('../runner', () => ({
      SKIPPED_LOCKED: 75,
      log: jest.fn(),
      acquireLock: jest.fn().mockReturnValue(true),
      releaseLock: jest.fn(),
      hasPendingIssues: jest.fn().mockResolvedValue(true),
      setIssueInProgress: jest.fn().mockResolvedValue(undefined),
      notifyUsageLimitToAllActiveIssues: jest.fn().mockResolvedValue(undefined),
      removeUsageLimitLabel: jest.fn().mockResolvedValue(undefined),
      enqueue: jest.fn(),
      dequeue: jest.fn().mockReturnValue(null),
      isQueued: jest.fn().mockReturnValue(false),
      isLocked: jest.fn().mockReturnValue(false),
      loadQueue: jest.fn().mockReturnValue([]),
      LOG_DIR: '/tmp/test-logs'
    }));

    jest.doMock('child_process', () => ({
      spawn: jest.fn()
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
    jest.dontMock('../lib/discordNotifier');
    jest.dontMock('../runner');
    jest.dontMock('child_process');
    jest.restoreAllMocks();
  });

  test('DiscordNotifier is constructed with DISCORD_WEBHOOK_URL', () => {
    loadWebhookServer();

    expect(DiscordNotifierMock).toHaveBeenCalledWith(webhookUrl);
  });

  test('start() is called on DiscordNotifier instance', () => {
    loadWebhookServer();
    const instance = DiscordNotifierMock.mock.results[0].value;

    expect(instance.start).toHaveBeenCalled();
  });

  test('stdout and stderr writes are forwarded to notifier.add()', () => {
    loadWebhookServer();
    const instance = DiscordNotifierMock.mock.results[0].value;

    process.stdout.write('test stdout log message');
    process.stderr.write(Buffer.from('test stderr log message'));

    expect(instance.add).toHaveBeenCalledWith(expect.stringContaining('test stdout log message'));
    expect(instance.add).toHaveBeenCalledWith(expect.stringContaining('test stderr log message'));
  });
});
