import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const { buildWorkerReportMessage, notifyWorkerReport } = await import('../lib/workerReportNotifier.js');

describe('workerReportNotifier', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('buildWorkerReportMessage', () => {
    it('includes the worker header and the report body', () => {
      const msg = buildWorkerReportMessage('codex', '# Worker Report\n## Next Action\nREADY_FOR_REVIEW');
      expect(msg).toContain('📋 **Codex Worker Report**');
      expect(msg).toContain('READY_FOR_REVIEW');
    });

    it('uses the Antigravity label', () => {
      const msg = buildWorkerReportMessage('antigravity', 'done');
      expect(msg).toContain('📋 **Antigravity Worker Report**');
    });

    it('returns a header-only message for empty report', () => {
      const msg = buildWorkerReportMessage('codex', '   \n  ');
      expect(msg).toContain('📋 **Codex Worker Report**');
      expect(msg).toContain('レポートが空です');
    });
  });

  describe('notifyWorkerReport', () => {
    it('returns false and does nothing when no webhook is resolvable', async () => {
      const result = await notifyWorkerReport({ worker: 'codex', report: 'hello', webhookUrl: null });
      expect(result).toBe(false);
      expect(DiscordNotifierMock).not.toHaveBeenCalled();
    });

    it('returns false for an empty report even with a valid webhook', async () => {
      const result = await notifyWorkerReport({ worker: 'codex', report: '   ', webhookUrl: 'https://example.com/webhook' });
      expect(result).toBe(false);
      expect(DiscordNotifierMock).not.toHaveBeenCalled();
    });

    it('sends notification when given a report and an explicit webhook', async () => {
      const result = await notifyWorkerReport({ worker: 'codex', report: 'some output', webhookUrl: 'https://example.com/webhook' });
      expect(result).toBe(true);
      expect(DiscordNotifierMock).toHaveBeenCalledWith('https://example.com/webhook');
      expect(mockDiscordNotifier.add).toHaveBeenCalled();
      expect(mockDiscordNotifier.stop).toHaveBeenCalled();
    });

    it('resolves the webhook from secrets when not provided', async () => {
      mockSecrets.getSecret.mockImplementation((key: unknown) =>
        key === 'DISCORD_WEBHOOK_URL_NOTIFY' ? 'https://example.com/notify' : null);
      const result = await notifyWorkerReport({ worker: 'antigravity', report: 'output' });
      expect(result).toBe(true);
      expect(DiscordNotifierMock).toHaveBeenCalledWith('https://example.com/notify');
    });

    it('reads the report content from reportPath', async () => {
      const tmp = path.join(os.tmpdir(), `worker-report-${Date.now()}.md`);
      fs.writeFileSync(tmp, '# Worker Report\nFROM_FILE\n## Next Action\nREADY_FOR_REVIEW');
      try {
        const result = await notifyWorkerReport({ worker: 'codex', reportPath: tmp, webhookUrl: 'https://example.com/webhook' });
        expect(result).toBe(true);
        const posted = (mockDiscordNotifier.add as any).mock.calls[0][0] as string;
        expect(posted).toContain('FROM_FILE');
      } finally {
        fs.unlinkSync(tmp);
      }
    });

    it('returns false when reportPath cannot be read', async () => {
      const result = await notifyWorkerReport({ worker: 'codex', reportPath: '/no/such/file.md', webhookUrl: 'https://example.com/webhook' });
      expect(result).toBe(false);
      expect(DiscordNotifierMock).not.toHaveBeenCalled();
    });

    it('handles errors gracefully', async () => {
      (mockDiscordNotifier.add as any).mockImplementationOnce(() => { throw new Error('boom'); });
      const result = await notifyWorkerReport({ worker: 'codex', report: 'output', webhookUrl: 'https://example.com/webhook' });
      expect(result).toBe(false);
    });
  });
});
