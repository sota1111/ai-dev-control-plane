import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import {
  configureRunnerLock,
  acquireLaneLock,
  releaseLaneLock,
  acquireLock,
  releaseLock,
} from '../lib/runnerLock.js';

/**
 * SOT-1559: worktree(branch)-granular locking. The runner keys a serialization lane by
 * `repo--branch` and gives each lane its own lock file (mirrored here by laneLockFile). This
 * verifies the lock granularity the git-worktree isolation relies on:
 *   - distinct lanes (= distinct branch/worktree) → distinct lock files → concurrent (異 branch 並列可)
 *   - same lane (= same branch/worktree) → same lock file → serial (同一 branch 直列 safety valve)
 */
describe('runnerLock worktree(branch)-granular locking (SOT-1559)', () => {
  let dir: string;

  // Mirrors runner.laneLockFile: default lane → the shared runner.lock, otherwise a per-lane file.
  const laneLockFile = (lane?: string): string =>
    path.join(dir, !lane || lane === 'default' ? 'runner.lock' : `runner.${lane}.lock`);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sot1559-lock-'));
    configureRunnerLock({
      logDir: dir,
      lockFile: laneLockFile(),
      staleLockMs: 60_000,
      laneLockFile,
      log: () => {},
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('異 branch は並列可: distinct branch lanes acquire distinct locks concurrently', () => {
    expect(acquireLaneLock('repo--feat-a')).toBe(true);
    // A different branch/worktree lane is NOT blocked by feat-a's lock.
    expect(acquireLaneLock('repo--feat-b')).toBe(true);

    // Each lane wrote its own lock file.
    expect(fs.existsSync(laneLockFile('repo--feat-a'))).toBe(true);
    expect(fs.existsSync(laneLockFile('repo--feat-b'))).toBe(true);
  });

  it('同一 branch は直列: a second acquire of the same lane is blocked while held', () => {
    expect(acquireLaneLock('repo--feat-a')).toBe(true);
    // Same lane = same worktree = same lock file → serial (the safety valve).
    expect(acquireLaneLock('repo--feat-a')).toBe(false);

    // After release the same lane can be re-acquired.
    releaseLaneLock('repo--feat-a');
    expect(acquireLaneLock('repo--feat-a')).toBe(true);
    releaseLaneLock('repo--feat-a');
  });

  it('the default lane maps to the shared runner.lock (repo-scope backward compatibility)', () => {
    expect(acquireLaneLock('default')).toBe(true);
    // acquireLock() (no lane) targets the same shared lock file → serial with the default lane.
    expect(acquireLock()).toBe(false);
    releaseLaneLock('default');
    expect(fs.existsSync(laneLockFile('default'))).toBe(false);
    releaseLock();
  });
});
