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

const {
  buildDetachedLaunchedMessage,
  buildDetachedCompletedMessage,
  notifyDetachedLaunched,
  notifyDetachedCompleted,
} = await import('../lib/laneNotifier.js');

describe('laneNotifier', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('buildDetachedLaunchedMessage', () => {
    it('includes issue / lane / pid', () => {
      const msg = buildDetachedLaunchedMessage({ issueId: 'SOT-1', lane: 'default', pid: 1234 });
      expect(msg).toContain('🚀 **Detached run launched**');
      expect(msg).toContain('issue: `SOT-1`');
      expect(msg).toContain('lane: `default`');
      expect(msg).toContain('pid: `1234`');
      expect(msg).not.toContain('(resume)');
    });

    it('marks resume runs and handles unknown pid', () => {
      const msg = buildDetachedLaunchedMessage({ issueId: 'SOT-2', lane: 'simrepo', resume: true });
      expect(msg).toContain('(resume)');
      expect(msg).toContain('lane: `simrepo`');
      expect(msg).toContain('pid: `unknown`');
    });
  });

  describe('buildDetachedCompletedMessage', () => {
    const cases: Array<[any, string]> = [
      ['success', '✅'],
      ['unverified', '⚠️'],
      ['usage_limit', '⏳'],
      ['failed', '❌'],
    ];
    it.each(cases)('uses the %s emoji and shows issue/lane/exit', (outcome, emoji) => {
      const msg = buildDetachedCompletedMessage({ issueId: 'SOT-3', lane: 'default', exitCode: 0, outcome });
      expect(msg).toContain(emoji);
      expect(msg).toContain('issue: `SOT-3`');
      expect(msg).toContain('lane: `default`');
      expect(msg).toContain('exit: `0`');
    });

    it('renders usage_limit as a resume re-injection', () => {
      const msg = buildDetachedCompletedMessage({ issueId: 'SOT-4', lane: 'default', exitCode: 1, outcome: 'usage_limit' });
      expect(msg).toContain('resume');
    });
  });

  describe('notify functions', () => {
    it('return false and skip Discord when no webhook is configured', async () => {
      const launched = await notifyDetachedLaunched({ issueId: 'SOT-5', lane: 'default', webhookUrl: null });
      const completed = await notifyDetachedCompleted({ issueId: 'SOT-5', lane: 'default', exitCode: 0, outcome: 'success', webhookUrl: null });
      expect(launched).toBe(false);
      expect(completed).toBe(false);
      expect(DiscordNotifierMock).not.toHaveBeenCalled();
    });

    it('post to Discord when an explicit webhook is provided', async () => {
      const ok = await notifyDetachedLaunched({ issueId: 'SOT-6', lane: 'default', pid: 7, webhookUrl: 'https://hook' });
      expect(ok).toBe(true);
      expect(DiscordNotifierMock).toHaveBeenCalledWith('https://hook');
      expect(mockDiscordNotifier.add).toHaveBeenCalled();
      expect(mockDiscordNotifier.stop).toHaveBeenCalled();
    });
  });
});
