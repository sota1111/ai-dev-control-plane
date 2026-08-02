import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// The lib has a module cycle (detachedState → laneNotifier → cooldownNotifier → workerCooldown →
// runner → detachedState) that only resolves when entered via runner.ts — the production entry
// point. Import runner first, then load detachedState dynamically, mirroring production.
let ds: typeof import('../lib/detachedState.js');
beforeAll(async () => {
  await import('../runner.js');
  ds = await import('../lib/detachedState.js');
});

const HOUR = 60 * 60 * 1000;

describe('detachedState — runDetachedWatchdog (design §34 停滞検出)', () => {
  let dir: string;
  let logs: Array<{ tag: string; message: string }>;

  const configureDetachedState: typeof ds.configureDetachedState = (...args) => ds.configureDetachedState(...args);
  const writeDetachedSentinel: typeof ds.writeDetachedSentinel = (...args) => ds.writeDetachedSentinel(...args);
  const detachedLogFile: typeof ds.detachedLogFile = (...args) => ds.detachedLogFile(...args);
  const runDetachedWatchdog: typeof ds.runDetachedWatchdog = (...args) => ds.runDetachedWatchdog(...args);
  const clearStallWarnings: typeof ds.clearStallWarnings = (...args) => ds.clearStallWarnings(...args);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-'));
    logs = [];
    configureDetachedState({
      logDir: dir,
      inflightFile: path.join(dir, 'inflight.json'),
      inflightTtlMs: 2 * HOUR,
      detachedDir: path.join(dir, 'detached'),
      log: (tag, message) => logs.push({ tag, message }),
      processCompletedRun: async () => ({ lockConflict: false, resultKind: 'TASK_COMPLETED' }),
      resolveLane: () => 'default',
      detachedOutcomeForKind: () => 'completed' as any,
    });
    clearStallWarnings();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // lastActivity = max(sentinel.startedAt, log mtime), so a stalled run needs BOTH to be old
  // (a fresh run with no output yet must not look stalled).
  function ageRun(issueId: string, pid: number | undefined, ageMs: number): void {
    const startedAt = new Date(Date.now() - ageMs).toISOString();
    fs.mkdirSync(path.join(dir, 'detached'), { recursive: true });
    fs.writeFileSync(ds.detachedSentinelFile(issueId), JSON.stringify({ issueId, pid: pid ?? null, startedAt }));
    const file = detachedLogFile(issueId);
    fs.writeFileSync(file, 'output\n');
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(file, past, past);
  }

  it('detects a live run whose log has not moved past the stall threshold (warn, no kill)', () => {
    ageRun('SOT-1', process.pid, 3 * HOUR);
    const stalled = runDetachedWatchdog({ stallMs: 2 * HOUR, killMs: 0 });
    expect(stalled).toHaveLength(1);
    expect(stalled[0].issueId).toBe('SOT-1');
    expect(stalled[0].killed).toBe(false);
    expect(logs.some((l) => l.tag === 'WATCHDOG' && l.message.includes('no output'))).toBe(true);
  });

  it('does not flag a run with recent output', () => {
    ageRun('SOT-1', process.pid, 10 * 60 * 1000); // 10 min
    expect(runDetachedWatchdog({ stallMs: 2 * HOUR, killMs: 0 })).toHaveLength(0);
  });

  it('warns only once per stall window (no reaper-tick spam)', () => {
    ageRun('SOT-1', process.pid, 3 * HOUR);
    runDetachedWatchdog({ stallMs: 2 * HOUR, killMs: 0 });
    runDetachedWatchdog({ stallMs: 2 * HOUR, killMs: 0 });
    expect(logs.filter((l) => l.tag === 'WATCHDOG').length).toBe(1);
  });

  it('skips dead PIDs (owned by reapDeadDetachedSentinels)', () => {
    const dead = spawnSync('true');
    ageRun('SOT-1', dead.pid, 3 * HOUR);
    expect(runDetachedWatchdog({ stallMs: 2 * HOUR, killMs: 0 })).toHaveLength(0);
  });

  it('kills a run stalled past the kill threshold so the reapers can recover it', async () => {
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    try {
      ageRun('SOT-1', child.pid, 13 * HOUR);
      const stalled = runDetachedWatchdog({ stallMs: 2 * HOUR, killMs: 12 * HOUR });
      expect(stalled).toHaveLength(1);
      expect(stalled[0].killed).toBe(true);
      await new Promise((resolve) => child.on('exit', resolve));
      expect(logs.some((l) => l.tag === 'WATCHDOG' && l.message.includes('killed'))).toBe(true);
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }
  });

  it('is fully disabled with stallMs=0', () => {
    ageRun('SOT-1', process.pid, 30 * HOUR);
    expect(runDetachedWatchdog({ stallMs: 0, killMs: 0 })).toHaveLength(0);
  });
});
