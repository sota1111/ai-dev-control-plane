import fs from 'node:fs';

/**
 * Shared low-level primitives the lock operations need. These are owned by runner.ts
 * (LOG_DIR / LOCK_FILE / STALE_LOCK_MS / laneLockFile / log) and injected once at module
 * init via configureRunnerLock(). Injection (rather than importing from runner.ts) avoids a
 * circular import; it is safe because the lock operations only run at runtime (drain/reaper),
 * never at import time, while configureRunnerLock() runs during runner.ts module init.
 */
export interface RunnerLockDeps {
  logDir: string;
  lockFile: string;
  staleLockMs: number;
  laneLockFile: (lane?: string) => string;
  log: (tag: string, message: string, context?: Record<string, any>) => void;
}

let deps: RunnerLockDeps | null = null;

export function configureRunnerLock(d: RunnerLockDeps): void {
  deps = d;
}

function requireDeps(): RunnerLockDeps {
  if (!deps) {
    throw new Error('runnerLock not configured: call configureRunnerLock() first');
  }
  return deps;
}

// Lock acquisition over an arbitrary lock file. The default-lane lock (LOCK_FILE) and any per-lane
// lock (laneLockFile(lane), SOT-933 N-slot pool) share this identical logic; same-lane → same file →
// serial (the 同一 branch/同一 repo safety valve), distinct lanes → distinct files → concurrent.
export function acquireLockFile(lockFile: string, context: Record<string, any> = {}): boolean {
  const { logDir, staleLockMs, log } = requireDeps();
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    if (!fs.existsSync(lockFile)) {
      fs.writeFileSync(lockFile, `${process.pid}:${new Date().toISOString()}`);
      log('LOCK', 'acquired', context);
      return true;
    }

    const content = fs.readFileSync(lockFile, 'utf8');
    const parts = content.split(':');
    const pidStr = parts[0];
    const timestampStr = parts.slice(1).join(':');
    const pid = parseInt(pidStr, 10);
    const timestamp = new Date(timestampStr);

    let isDead = false;
    try {
      process.kill(pid, 0);
    } catch (e: any) {
      if (e.code === 'ESRCH') {
        isDead = true;
      }
    }

    const isStale = (Date.now() - timestamp.getTime()) > staleLockMs;

    if (isDead || isStale) {
      const reason = isDead ? 'dead process' : 'stale';
      log('LOCK', `removing ${reason} lock`, { oldPid: pidStr });
      fs.unlinkSync(lockFile);
      fs.writeFileSync(lockFile, `${process.pid}:${new Date().toISOString()}`);
      log('LOCK', 'acquired (after stale/dead removal)', context);
      return true;
    }

    log('LOCK', `SKIPPED_LOCKED lock held by pid=${pid}`, context);
    return false;
  } catch (err: any) {
    log('LOCK', `ERROR: ${err.message}`, context);
    return false;
  }
}

export function releaseLockFile(lockFile: string): void {
  const { log } = requireDeps();
  try {
    if (fs.existsSync(lockFile)) {
      const content = fs.readFileSync(lockFile, 'utf8');
      const [pidStr] = content.split(':');
      if (parseInt(pidStr, 10) === process.pid) {
        fs.unlinkSync(lockFile);
        log('LOCK', 'released');
      }
    }
  } catch (err: any) {
    log('LOCK', `release ERROR: ${err.message}`);
  }
}

export function acquireLock(context: Record<string, any> = {}): boolean {
  return acquireLockFile(requireDeps().lockFile, context);
}

export function releaseLock(): void {
  releaseLockFile(requireDeps().lockFile);
}

// Lane-scoped lock used by the N-slot pool (SOT-933). The default lane resolves to LOCK_FILE, so
// acquireLaneLock('default') is identical to acquireLock(). A non-default lane gets its own lock file.
export function acquireLaneLock(lane: string, context: Record<string, any> = {}): boolean {
  return acquireLockFile(requireDeps().laneLockFile(lane), { ...context, lane });
}

export function releaseLaneLock(lane: string): void {
  releaseLockFile(requireDeps().laneLockFile(lane));
}

// Unconditionally remove the runner lock regardless of which PID owns it.
// Used by the Discord /recover force path to break a wedged lock held by a
// hung/alive holder (acquireLock already auto-reclaims dead/stale locks, so this
// is only needed for the "alive but stuck" case). Returns the removed lock's raw
// content (pid:timestamp) or null if no lock existed. Safe because run_auto.sh's
// OS-level flock still serializes the heavy claude runs even if this JS lock is broken.
export function forceReleaseLock(): string | null {
  const { lockFile, log } = requireDeps();
  try {
    if (!fs.existsSync(lockFile)) return null;
    const content = fs.readFileSync(lockFile, 'utf8');
    fs.unlinkSync(lockFile);
    log('LOCK', `force-released (was: ${content})`);
    return content;
  } catch (err: any) {
    log('LOCK', `forceReleaseLock ERROR: ${err.message}`);
    return null;
  }
}

export function isLocked(): boolean {
  const { lockFile, staleLockMs } = requireDeps();
  try {
    if (!fs.existsSync(lockFile)) return false;
    const content = fs.readFileSync(lockFile, 'utf8');
    const parts = content.split(':');
    const pid = parseInt(parts[0], 10);
    const timestamp = new Date(parts.slice(1).join(':'));
    if (isNaN(pid)) return false;
    const isStale = (Date.now() - timestamp.getTime()) > staleLockMs;
    if (isStale) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      return e.code !== 'ESRCH';
    }
  } catch (err) {
    return false;
  }
}
