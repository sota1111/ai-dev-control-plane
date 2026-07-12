import { jest } from '@jest/globals';

const mockFs = {
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
  createWriteStream: jest.fn(),
  appendFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  realpathSync: jest.fn().mockImplementation(p => p),
};

jest.unstable_mockModule('node:fs', () => ({
  default: mockFs,
  ...mockFs
}));

jest.unstable_mockModule('../runner.js', () => ({
  linearQuery: jest.fn(),
  enqueue: jest.fn(),
}));

const fs = await import('node:fs');
const core = await import('../lib/schedulerCore.js');
const scheduler = await import('../scheduler.js');

describe('schedulerCore', () => {
  test('getConfig returns defaults', () => {
    const config = core.getConfig({});
    expect(config.interval).toBe(3600);
    expect(config.checkInterval).toBe(60);
    expect(config.webhookMode).toBe(false);
  });

  test('getConfig returns overrides', () => {
    const config = core.getConfig({
      INTERVAL: '1000',
      CHECK_INTERVAL: '30',
      WEBHOOK_MODE: 'true',
    });
    expect(config.interval).toBe(1000);
    expect(config.checkInterval).toBe(30);
    expect(config.webhookMode).toBe(true);
  });

  test('buildActiveIssuesQuery contains required fields', () => {
    const query = core.buildActiveIssuesQuery();
    expect(query).toContain('"unstarted"');
    expect(query).toContain('"started"');
    expect(query).toContain('orderBy: priority');
    expect(query).toContain('first: 10');
    expect(query).toContain('identifier');
  });

  test('parseActiveIdentifiers returns identifiers', () => {
    const data = {
      issues: {
        nodes: [{ identifier: 'ID-1' }, { identifier: 'ID-2' }],
      },
    };
    expect(core.parseActiveIdentifiers(data)).toEqual(['ID-1', 'ID-2']);
  });

  test('parseActiveIdentifiers handles empty/missing data', () => {
    expect(core.parseActiveIdentifiers(null)).toEqual([]);
    expect(core.parseActiveIdentifiers({})).toEqual([]);
    expect(core.parseActiveIdentifiers({ issues: {} })).toEqual([]);
    expect(core.parseActiveIdentifiers({ issues: { nodes: [] } })).toEqual([]);
  });

  test('formatStatusLines running', () => {
    const lines = core.formatStatusLines({
      running: true,
      pid: '1234',
      schedulerLog: '/log/path',
      linearState: '2023-01-01',
      hasLinearKey: true,
      checkInterval: 60,
      interval: 3600,
    });
    expect(lines).toContain('Scheduler is running (PID: 1234)');
    expect(lines).toContain('Log: /log/path');
    expect(lines).toContain('Last Linear updatedAt: 2023-01-01');
    expect(lines).toContain('Mode: Linear polling (CHECK_INTERVAL=60s)');
  });

  test('formatStatusLines fallback mode', () => {
    const lines = core.formatStatusLines({
      running: true,
      pid: '1234',
      schedulerLog: '/log/path',
      linearState: null,
      hasLinearKey: false,
      checkInterval: 60,
      interval: 3600,
    });
    expect(lines).toContain('Last Linear updatedAt: (not yet checked)');
    expect(lines).toContain(
      'Mode: Fixed interval fallback (INTERVAL=3600s) — set LINEAR_API_KEY to enable Linear polling'
    );
  });

  test('formatStatusLines not running', () => {
    const lines = core.formatStatusLines({
      running: false,
      pid: null,
      schedulerLog: '/log/path',
    });
    expect(lines).toContain('Scheduler is not running');
  });

  test('formatStatusLines stale PID', () => {
    const lines = core.formatStatusLines({
      running: false,
      pid: '1234',
      schedulerLog: '/log/path',
    });
    expect(lines).toContain('Scheduler not running (stale PID file)');
  });
});

describe('scheduler CLI logic', () => {
  let originalKill;
  beforeAll(() => {
    originalKill = process.kill;
    process.kill = jest.fn();
  });
  afterAll(() => {
    process.kill = originalKill;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    console.log = jest.fn();
  });

  test('stop logic - alive PID', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('1234');
    process.kill.mockImplementation((pid, sig) => {
      if (sig === 0) return true;
      return true;
    });

    // Mock fs.existsSync to return false eventually for the PID file wait loop
    let existsCallCount = 0;
    fs.existsSync.mockImplementation((path) => {
      if (path === core.PID_FILE) {
        existsCallCount++;
        return existsCallCount < 2;
      }
      return true;
    });

    await scheduler.stop();

    expect(process.kill).toHaveBeenCalledWith(1234, 'SIGTERM');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Scheduler stopped (PID: 1234)'));
  });

  test('stop logic - stale PID', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('1234');
    process.kill.mockImplementation((pid, sig) => {
      if (sig === 0) throw new Error('ESRCH');
      return true;
    });

    await scheduler.stop();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('stale PID file removed'));
    expect(fs.unlinkSync).toHaveBeenCalledWith(core.PID_FILE);
  });

  test('stop logic - missing PID', async () => {
    fs.existsSync.mockReturnValue(false);

    await scheduler.stop();

    expect(console.log).toHaveBeenCalledWith('Scheduler is not running');
  });
});
