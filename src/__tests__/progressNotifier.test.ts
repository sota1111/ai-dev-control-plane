import { jest } from '@jest/globals';

const mockDiscordNotifier = {
  add: jest.fn(),
  stop: (jest.fn() as any).mockResolvedValue(undefined),
};

const DiscordNotifierMock = jest.fn().mockImplementation(() => mockDiscordNotifier);

const mockSecrets = {
  getSecret: jest.fn(),
};

jest.unstable_mockModule('../lib/discordNotifier.js', () => ({
  DiscordNotifier: DiscordNotifierMock,
}));

jest.unstable_mockModule('../config/secrets.js', () => ({
  ...mockSecrets,
  initSecrets: (jest.fn() as any).mockResolvedValue(undefined),
}));

const { buildProgressMessage, notifyProgress } = await import('../lib/progressNotifier.js');

describe('progressNotifier', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('buildProgressMessage', () => {
    it('prepends an identifiable issue/role/worker header', () => {
      const msg = buildProgressMessage('backend done', { issueId: 'SOT-1577', role: 'implementation', worker: 'claude' });
      expect(msg).toBe('🔧 **[SOT-1577 · implementation · claude]** backend done');
    });

    it('falls back to a generic header when no context is given', () => {
      expect(buildProgressMessage('starting')).toBe('🔧 **progress** starting');
    });

    it('includes only the tags that are present', () => {
      expect(buildProgressMessage('x', { issueId: 'SOT-1' })).toBe('🔧 **[SOT-1]** x');
    });
  });

  describe('notifyProgress', () => {
    it('sends the built message via DiscordNotifier when a webhook is configured', async () => {
      const ok = await notifyProgress({ message: 'started', issueId: 'SOT-1577', webhookUrl: 'https://discord/hook' });
      expect(ok).toBe(true);
      expect(DiscordNotifierMock).toHaveBeenCalledWith('https://discord/hook');
      expect(mockDiscordNotifier.add).toHaveBeenCalledWith('🔧 **[SOT-1577]** started');
      expect(mockDiscordNotifier.stop).toHaveBeenCalled();
    });

    it('resolves the webhook from secrets when not passed', async () => {
      mockSecrets.getSecret.mockReturnValue('https://discord/secret-hook');
      const ok = await notifyProgress({ message: 'milestone' });
      expect(ok).toBe(true);
      expect(mockSecrets.getSecret).toHaveBeenCalledWith('DISCORD_WEBHOOK_URL');
      expect(DiscordNotifierMock).toHaveBeenCalledWith('https://discord/secret-hook');
    });

    it('returns false (no send) on an empty message', async () => {
      const ok = await notifyProgress({ message: '   ', webhookUrl: 'https://discord/hook' });
      expect(ok).toBe(false);
      expect(DiscordNotifierMock).not.toHaveBeenCalled();
    });

    it('returns false when no webhook is configured', async () => {
      mockSecrets.getSecret.mockReturnValue(undefined);
      const ok = await notifyProgress({ message: 'hi' });
      expect(ok).toBe(false);
      expect(DiscordNotifierMock).not.toHaveBeenCalled();
    });
  });
});
