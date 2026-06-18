import { jest } from '@jest/globals';

const mockDiscordNotifier = {
  add: jest.fn(),
  stop: (jest.fn() as any).mockResolvedValue(undefined),
};

const DiscordNotifierMock = jest.fn().mockImplementation(() => mockDiscordNotifier);

const mockSecrets = {
  getSecret: jest.fn(),
};

const mockWorkerCooldown = {
  getWorkerCooldownStatus: jest.fn(),
};

jest.unstable_mockModule('../lib/discordNotifier.js', () => ({
  DiscordNotifier: DiscordNotifierMock,
}));

jest.unstable_mockModule('../config/secrets.js', () => ({
  ...mockSecrets,
  initSecrets: (jest.fn() as any).mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../lib/workerCooldown.js', () => mockWorkerCooldown);

const { resolveNotifyWebhook, buildCooldownMessage, notifyCooldown, buildUnknownResetMessage, notifyUsageLimitUnknownReset } = await import('../lib/cooldownNotifier.js');

describe('cooldownNotifier', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('resolveNotifyWebhook', () => {
    it('prefers notifyUrl if both provided', () => {
      expect(resolveNotifyWebhook('NOTIFY', 'FALLBACK')).toBe('NOTIFY');
    });

    it('uses fallbackUrl if notifyUrl is missing', () => {
      expect(resolveNotifyWebhook(null, 'FALLBACK')).toBe('FALLBACK');
      expect(resolveNotifyWebhook('', 'FALLBACK')).toBe('FALLBACK');
    });

    it('returns null if both are missing', () => {
      expect(resolveNotifyWebhook(null, null)).toBeNull();
    });
  });

  describe('buildCooldownMessage', () => {
    const mockStatus = {
      now: '2026-06-18T10:00:00Z',
      degraded: false,
      workers: [
        { worker: 'gemini', active: true, resumeAt: '2026-06-18T11:00:00Z', remainingHuman: '1h' },
        { worker: 'codex', active: false, resumeAt: null, remainingHuman: null },
        { worker: 'runner', active: false, resumeAt: null, remainingHuman: null },
      ]
    } as any;

    it('builds message for active worker', () => {
      const msg = buildCooldownMessage(mockStatus);
      expect(msg).toContain('⏳ **Worker Cooldown Status**');
      expect(msg).toContain('gemini: 復帰');
      expect(msg).toContain('(残り 1h)');
    });

    it('includes triggered worker if provided', () => {
      const msg = buildCooldownMessage(mockStatus, 'gemini');
      expect(msg).toContain('Triggered by: `gemini`');
    });

    it('includes DEGRADED line when degraded is true', () => {
      const degradedStatus = { ...mockStatus, degraded: true };
      const msg = buildCooldownMessage(degradedStatus);
      expect(msg).toContain('⚠️ **DEGRADED: gemini と codex が同時に停止中**');
    });

    it('returns a "all running" message when no workers are active', () => {
      const inactiveStatus = {
        ...mockStatus,
        workers: mockStatus.workers.map((w: any) => ({ ...w, active: false }))
      };
      const msg = buildCooldownMessage(inactiveStatus);
      expect(msg).toBe('全workerが稼働中');
    });
  });

  describe('notifyCooldown', () => {
    it('returns false and does nothing when no webhook is configured', async () => {
      mockSecrets.getSecret.mockReturnValue(null);
      const result = await notifyCooldown();
      expect(result).toBe(false);
      expect(DiscordNotifierMock).not.toHaveBeenCalled();
    });

    it('sends notification when webhook is provided', async () => {
      const status = {
        now: '2026-06-18T10:00:00Z',
        degraded: false,
        workers: [
          { worker: 'gemini', active: true, resumeAt: '2026-06-18T11:00:00Z', remainingHuman: '1h' },
          { worker: 'codex', active: false, resumeAt: null, remainingHuman: null },
          { worker: 'runner', active: false, resumeAt: null, remainingHuman: null },
        ]
      } as any;
      mockWorkerCooldown.getWorkerCooldownStatus.mockReturnValue(status);
      
      const result = await notifyCooldown({ webhookUrl: 'https://example.com/webhook' });
      
      expect(result).toBe(true);
      expect(DiscordNotifierMock).toHaveBeenCalledWith('https://example.com/webhook');
      expect(mockDiscordNotifier.add).toHaveBeenCalled();
      expect(mockDiscordNotifier.stop).toHaveBeenCalled();
    });

    it('handles errors gracefully', async () => {
      mockSecrets.getSecret.mockReturnValue('https://example.com/webhook');
      mockWorkerCooldown.getWorkerCooldownStatus.mockImplementation(() => {
        throw new Error('Test error');
      });
      
      const result = await notifyCooldown();
      expect(result).toBe(false);
    });
  });

  describe('buildUnknownResetMessage', () => {
    it('builds message for unknown reset', () => {
      const msg = buildUnknownResetMessage('gemini');
      expect(msg).toContain('⏳ **Worker Usage Limit**');
      expect(msg).toContain('Triggered by: `gemini`');
      expect(msg).toContain('gemini: usage-limit を検知しました（復帰時間: 不明）');
    });
  });

  describe('notifyUsageLimitUnknownReset', () => {
    it('returns false and does nothing when no webhook is configured', async () => {
      mockSecrets.getSecret.mockReturnValue(null);
      const result = await notifyUsageLimitUnknownReset({ worker: 'gemini' });
      expect(result).toBe(false);
      expect(DiscordNotifierMock).not.toHaveBeenCalled();
    });

    it('sends notification when webhook is provided', async () => {
      const result = await notifyUsageLimitUnknownReset({ worker: 'gemini', webhookUrl: 'https://example.com/webhook' });
      
      expect(result).toBe(true);
      expect(DiscordNotifierMock).toHaveBeenCalledWith('https://example.com/webhook');
      expect(mockDiscordNotifier.add).toHaveBeenCalled();
      expect(mockDiscordNotifier.stop).toHaveBeenCalled();
    });

    it('handles errors gracefully', async () => {
      mockSecrets.getSecret.mockReturnValue('https://example.com/webhook');
      mockDiscordNotifier.add.mockImplementation(() => {
        throw new Error('Test error');
      });
      
      const result = await notifyUsageLimitUnknownReset({ worker: 'gemini' });
      expect(result).toBe(false);
    });
  });
});
