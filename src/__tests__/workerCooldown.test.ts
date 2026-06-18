import { jest } from '@jest/globals';

const mockFs = {
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  rmSync: jest.fn(),
  mkdtempSync: jest.fn()
};

const mockRunner = {
  LOG_DIR: '/mock/log/dir',
  getUsageLimitCooldownUntil: jest.fn()
};

jest.unstable_mockModule('node:fs', () => ({ ...mockFs, default: mockFs }));
jest.unstable_mockModule('../runner.js', () => mockRunner);

const fs: any = mockFs;
const runner: any = mockRunner;
const { getWorkerCooldownStatus, formatRemaining } = await import('../lib/workerCooldown.js');

describe('workerCooldown', () => {
  let tmpDir: string;
  const nowMs = new Date('2026-06-18T10:00:00Z').getTime();

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = '/fake/tmp/dir';
    runner.getUsageLimitCooldownUntil.mockReturnValue(null);
  });

  describe('formatRemaining', () => {
    it('formats seconds correctly', () => {
      expect(formatRemaining(0)).toBe('0s');
      expect(formatRemaining(30)).toBe('30s');
      expect(formatRemaining(60)).toBe('1m');
      expect(formatRemaining(65)).toBe('1m 5s');
      expect(formatRemaining(3600)).toBe('1h');
      expect(formatRemaining(3665)).toBe('1h 1m 5s');
      expect(formatRemaining(7200 + 300)).toBe('2h 5m');
    });
  });

  describe('getWorkerCooldownStatus', () => {
    it('returns all inactive when no files exist and runner has no cooldown', () => {
      fs.existsSync.mockReturnValue(false);
      const status = getWorkerCooldownStatus(nowMs, tmpDir);
      
      expect(status.degraded).toBe(false);
      expect(status.workers).toHaveLength(3);
      status.workers.forEach(w => {
        expect(w.active).toBe(false);
        expect(w.resumeAt).toBeNull();
      });
    });

    it('identifies gemini as active', () => {
      const resumeAtEpoch = Math.floor(nowMs / 1000) + 3600; // +1 hour
      
      fs.existsSync.mockImplementation((p: string) => p.includes('gemini.cooldown.json'));
      fs.readFileSync.mockReturnValue(JSON.stringify({
        resumeAtEpoch,
        detectedAt: new Date(nowMs).toISOString(),
        reason: 'gemini_usage_limit'
      }));

      const status = getWorkerCooldownStatus(nowMs, tmpDir);
      const gemini = status.workers.find(w => w.worker === 'gemini')!;
      
      expect(gemini.active).toBe(true);
      expect(gemini.resumeAt).toBe(new Date(resumeAtEpoch * 1000).toISOString());
      expect(gemini.remainingSeconds).toBe(3600);
      expect(gemini.remainingHuman).toBe('1h');
      expect(status.degraded).toBe(false);
    });

    it('identifies codex as active', () => {
      const resumeAtEpoch = Math.floor(nowMs / 1000) + 1800; // +30 mins
      
      fs.existsSync.mockImplementation((p: string) => p.includes('codex.cooldown.json'));
      fs.readFileSync.mockReturnValue(JSON.stringify({
        resumeAtEpoch,
        detectedAt: new Date(nowMs).toISOString(),
        reason: 'codex_usage_limit'
      }));

      const status = getWorkerCooldownStatus(nowMs, tmpDir);
      const codex = status.workers.find(w => w.worker === 'codex')!;
      
      expect(codex.active).toBe(true);
      expect(codex.remainingSeconds).toBe(1800);
      expect(codex.remainingHuman).toBe('30m');
      expect(status.degraded).toBe(false);
    });

    it('sets degraded=true when BOTH gemini and codex are active', () => {
      const geminiEpoch = Math.floor(nowMs / 1000) + 3600;
      const codexEpoch = Math.floor(nowMs / 1000) + 1800;
      
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation((p: string) => {
        if (p.includes('gemini.cooldown.json')) return JSON.stringify({ resumeAtEpoch: geminiEpoch });
        if (p.includes('codex.cooldown.json')) return JSON.stringify({ resumeAtEpoch: codexEpoch });
        return '{}';
      });

      const status = getWorkerCooldownStatus(nowMs, tmpDir);
      
      expect(status.degraded).toBe(true);
      expect(status.workers.find(w => w.worker === 'gemini')!.active).toBe(true);
      expect(status.workers.find(w => w.worker === 'codex')!.active).toBe(true);
    });

    it('identifies runner as active via mock', () => {
      fs.existsSync.mockReturnValue(false);
      const retryAt = new Date(nowMs + 600000).toISOString(); // +10 mins
      runner.getUsageLimitCooldownUntil.mockReturnValue({
        retryAt,
        active: true
      });

      const status = getWorkerCooldownStatus(nowMs, tmpDir);
      const r = status.workers.find(w => w.worker === 'runner')!;
      
      expect(r.active).toBe(true);
      expect(r.resumeAt).toBe(retryAt);
      expect(r.remainingSeconds).toBe(600);
      expect(r.remainingHuman).toBe('10m');
    });

    it('treats expired gemini cooldown as inactive', () => {
      const resumeAtEpoch = Math.floor(nowMs / 1000) - 10; // 10 seconds ago
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        resumeAtEpoch
      }));

      const status = getWorkerCooldownStatus(nowMs, tmpDir);
      const gemini = status.workers.find(w => w.worker === 'gemini')!;
      
      expect(gemini.active).toBe(false);
    });

    it('handles malformed JSON gracefully', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('invalid-json');

      const status = getWorkerCooldownStatus(nowMs, tmpDir);
      const gemini = status.workers.find(w => w.worker === 'gemini')!;
      
      expect(gemini.active).toBe(false);
    });
  });
});
