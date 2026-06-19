import { jest } from '@jest/globals';

const mockHandlers = {
  handleStatus: (jest.fn() as any).mockResolvedValue({ content: 'status-content' }),
  handleQueue: (jest.fn() as any).mockResolvedValue({ content: 'queue-content' }),
  handlePastQueue: (jest.fn() as any).mockResolvedValue({ content: 'pastqueue-content' }),
  handleReorder: (jest.fn() as any).mockResolvedValue({ content: 'reorder-content' }),
  handleCooldown: (jest.fn() as any).mockResolvedValue({ content: 'cooldown-content' }),
  handlePause: (jest.fn() as any).mockResolvedValue({ content: 'pause-content' }),
  handleResume: (jest.fn() as any).mockResolvedValue({ content: 'resume-content' }),
  handleReply: (jest.fn() as any).mockResolvedValue({ content: 'reply-content' }),
  handleRetry: (jest.fn() as any).mockResolvedValue({ content: 'retry-content' }),
};

const mockAskHandler = {
  handleAskCommand: (jest.fn() as any).mockResolvedValue({ status: 200, body: { type: 9, data: {} } }),
  handleAskModalSubmit: (jest.fn() as any).mockResolvedValue({ status: 200, body: { type: 4, data: {} } }),
  ASK_MODAL_CUSTOM_ID: 'discord_ask_modal',
};

const mockFollowup = {
  editOriginalInteractionResponse: (jest.fn() as any).mockResolvedValue({ status: 200, body: '{}' }),
};

const mockRunner = { log: jest.fn() };

jest.unstable_mockModule('../lib/discordCommandHandlers.js', () => ({ ...mockHandlers, default: mockHandlers }));
jest.unstable_mockModule('../lib/discordAskHandler.js', () => ({ ...mockAskHandler, default: mockAskHandler }));
jest.unstable_mockModule('../lib/discordInteractionFollowup.js', () => ({ ...mockFollowup, default: mockFollowup }));
jest.unstable_mockModule('../runner.js', () => ({ ...mockRunner, default: mockRunner }));

const router = await import('../lib/discordCommandRouter.js');
const { routeInteraction } = router;

const APPLICATION_COMMAND = 2;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('routeInteraction — /queue deferred response', () => {
  test('returns an immediate deferred (type 5) ephemeral response, not awaiting the Linear call', async () => {
    let resolveQueue: (v: any) => void = () => {};
    // Make handleQueue hang so we can prove the router does NOT await it before responding.
    (mockHandlers.handleQueue as any).mockImplementationOnce(
      () => new Promise((res) => { resolveQueue = res; }),
    );

    const interaction = {
      type: APPLICATION_COMMAND,
      application_id: 'app123',
      token: 'token456',
      data: { name: 'queue' },
    };

    const response = await routeInteraction(interaction);

    expect(response.status).toBe(200);
    expect(response.body.type).toBe(5); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    expect(response.body.data).toEqual({ flags: 64 }); // ephemeral, no content
    // followup must not have been sent yet — heavy work is still pending
    expect(mockFollowup.editOriginalInteractionResponse).not.toHaveBeenCalled();

    // Let the background task complete.
    resolveQueue({ content: 'queue-content' });
    await new Promise((r) => setImmediate(r));

    expect(mockHandlers.handleQueue).toHaveBeenCalledTimes(1);
    expect(mockFollowup.editOriginalInteractionResponse).toHaveBeenCalledWith(
      'app123',
      'token456',
      'queue-content',
    );
  });

  test('background error edits the original response with an error message', async () => {
    (mockHandlers.handleQueue as any).mockRejectedValueOnce(new Error('boom'));

    const interaction = {
      type: APPLICATION_COMMAND,
      application_id: 'app123',
      token: 'token456',
      data: { name: 'queue' },
    };

    const response = await routeInteraction(interaction);
    expect(response.body.type).toBe(5);

    await new Promise((r) => setImmediate(r));

    expect(mockFollowup.editOriginalInteractionResponse).toHaveBeenCalledWith(
      'app123',
      'token456',
      'エラーが発生しました: boom',
    );
  });
});

describe('routeInteraction — /pastqueue deferred response', () => {
  test('returns a deferred (type 5) ephemeral response and edits with handlePastQueue result', async () => {
    const interaction = {
      type: APPLICATION_COMMAND,
      application_id: 'app123',
      token: 'token456',
      data: { name: 'pastqueue' },
    };

    const response = await routeInteraction(interaction);

    expect(response.status).toBe(200);
    expect(response.body.type).toBe(5); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    expect(response.body.data).toEqual({ flags: 64 });

    await new Promise((r) => setImmediate(r));

    expect(mockHandlers.handlePastQueue).toHaveBeenCalledTimes(1);
    expect(mockFollowup.editOriginalInteractionResponse).toHaveBeenCalledWith(
      'app123',
      'token456',
      'pastqueue-content',
    );
  });
});

describe('routeInteraction — other commands unchanged', () => {
  test('/status returns a normal (type 4) ephemeral message synchronously', async () => {
    const interaction = {
      type: APPLICATION_COMMAND,
      application_id: 'app123',
      token: 'token456',
      data: { name: 'status' },
    };

    const response = await routeInteraction(interaction);

    expect(response.status).toBe(200);
    expect(response.body.type).toBe(4); // CHANNEL_MESSAGE_WITH_SOURCE
    expect(response.body.data).toEqual({ content: 'status-content', flags: 64 });
    expect(mockHandlers.handleStatus).toHaveBeenCalledTimes(1);
    expect(mockFollowup.editOriginalInteractionResponse).not.toHaveBeenCalled();
  });
});
