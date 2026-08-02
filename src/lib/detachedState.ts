import fs from 'node:fs';
import path from 'node:path';
import { isLocked } from './runnerLock.js';
import { notifyDetachedCompleted, DetachedOutcome } from './laneNotifier.js';
import type { QueueItem } from '../runner.js';

/**
 * Inflight tracking + detached long-run sentinels / done-markers + their reapers, extracted from
 * runner.ts (SOT-935 R5). Shared primitives (log / path+ttl constants) and the orchestration
 * callbacks the completion reaper feeds into (processCompletedRun / resolveLane /
 * detachedOutcomeForKind) are owned by runner.ts and injected once at module init via
 * configureDetachedState() to avoid a circular import. isLocked / notifyDetachedCompleted are
 * imported directly from their own modules. Injection is safe: configured at runner.ts import time,
 * used only at runtime (drain/reaper).
 */
export interface DetachedStateDeps {
  logDir: string;
  inflightFile: string;
  inflightTtlMs: number;
  detachedDir: string;
  log: (tag: string, message: string, context?: Record<string, any>) => void;
  processCompletedRun: (item: QueueItem, code: number, output: string) => Promise<{ lockConflict: boolean; resultKind: string }>;
  resolveLane: (laneOrEnv?: string | NodeJS.ProcessEnv) => string;
  detachedOutcomeForKind: (kind: string) => DetachedOutcome;
}

let deps: DetachedStateDeps | null = null;

export function configureDetachedState(d: DetachedStateDeps): void {
  deps = d;
}

function requireDeps(): DetachedStateDeps {
  if (!deps) {
    throw new Error('detachedState not configured: call configureDetachedState() first');
  }
  return deps;
}

interface InflightEntry {
  issueId: string;
  startedAt: string | null; // null => legacy/unknown entry, treated as stale by the reaper
}

// Read inflight as normalized records. Backward-compatible with the legacy `string[]` format
// (a bare string becomes `{ issueId, startedAt: null }`).
export function loadInflightRecords(): InflightEntry[] {
  const { inflightFile } = requireDeps();
  try {
    if (!fs.existsSync(inflightFile)) return [];
    const content = fs.readFileSync(inflightFile, 'utf8');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry: any): InflightEntry =>
        typeof entry === 'string'
          ? { issueId: entry, startedAt: null }
          : { issueId: entry.issueId, startedAt: entry.startedAt ?? null }
      )
      .filter((e: InflightEntry) => typeof e.issueId === 'string' && e.issueId.length > 0);
  } catch (err) {
    return [];
  }
}

export function saveInflightRecords(records: InflightEntry[]): void {
  const { logDir, inflightFile, log } = requireDeps();
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const tmp = inflightFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
    fs.renameSync(tmp, inflightFile);
  } catch (err: any) {
    log('RUNNER', `saveInflight ERROR: ${err.message}`);
  }
}

// Backward-compatible: returns issueIds only.
export function loadInflight(): string[] {
  return loadInflightRecords().map(r => r.issueId);
}

// Backward-compatible: accepts issueId[], preserving existing startedAt and stamping new ones.
export function saveInflight(list: string[]): void {
  const byId = new Map(loadInflightRecords().map(r => [r.issueId, r]));
  const now = new Date().toISOString();
  const records: InflightEntry[] = list.map(id => byId.get(id) ?? { issueId: id, startedAt: now });
  saveInflightRecords(records);
}

// Crash recovery: remove leaked inflight entries whose run never cleaned up.
// No-op while a run holds the lock; reaps entries older than INFLIGHT_TTL_MS, and
// legacy/unknown (null startedAt) entries. Returns the issueIds of the entries reaped.
export function reapStaleInflight(): string[] {
  const { inflightTtlMs, log } = requireDeps();
  if (isLocked()) return []; // a live run holds the lock; never touch inflight mid-run
  const records = loadInflightRecords();
  if (records.length === 0) return [];
  const now = Date.now();
  const kept: InflightEntry[] = [];
  const reaped: string[] = [];
  for (const r of records) {
    const startedMs = r.startedAt ? new Date(r.startedAt).getTime() : NaN;
    const isStale = Number.isNaN(startedMs) || (now - startedMs) > inflightTtlMs;
    if (isStale) reaped.push(r.issueId);
    else kept.push(r);
  }
  if (reaped.length > 0) {
    saveInflightRecords(kept);
    // A reaped inflight entry means its (possibly detached) run leaked — drop its sentinel too.
    for (const id of reaped) clearDetachedSentinel(id);
    log('REAPER', `reapStaleInflight: cleared ${reaped.length} leaked inflight entr${reaped.length === 1 ? 'y' : 'ies'}: ${reaped.join(', ')}`);
  }
  // Independently sweep detached sentinels whose recorded PID is no longer alive (the detached
  // run finished or crashed without removing its own sentinel). No-op while a run holds the lock.
  reapDeadDetachedSentinels();
  return reaped;
}

// Startup reconciliation (SOT-1438): on a FRESH process start, an inflight entry is only legitimate if
// a DETACHED run for it is still alive (its sentinel PID responds). Foreground runs are children of the
// spawner (webhook-server / scheduler); on a fresh start none survive, so their inflight is leaked
// (e.g. after a SIGKILL of the spawner) and would otherwise make isQueuedOrRunning() skip that issue's
// webhooks until the multi-hour inflight TTL. Reap every inflight entry NOT backed by a live sentinel
// and drop its sentinel. Unlike reapStaleInflight this ignores the TTL (a fresh start is proof no
// foreground run survived) but still keeps genuinely-alive detached runs. Best-effort; never throws.
export function reapLeakedInflightAtStartup(): string[] {
  const { log } = requireDeps();
  const reaped: string[] = [];
  try {
    const records = loadInflightRecords();
    if (records.length === 0) return reaped;
    const kept: InflightEntry[] = [];
    for (const r of records) {
      const sentinel = loadDetachedSentinel(r.issueId);
      let alive = false;
      if (sentinel && sentinel.pid != null) {
        try {
          process.kill(sentinel.pid, 0);
          alive = true;
        } catch (e: any) {
          alive = e.code !== 'ESRCH'; // EPERM etc. → process exists
        }
      }
      if (alive) kept.push(r);
      else {
        reaped.push(r.issueId);
        clearDetachedSentinel(r.issueId);
      }
    }
    if (reaped.length > 0) {
      saveInflightRecords(kept);
      log('RUNNER', `startup: reaped ${reaped.length} leaked inflight entr${reaped.length === 1 ? 'y' : 'ies'} not backed by a live run: ${reaped.join(', ')}`);
    }
  } catch (err: any) {
    log('RUNNER', `reapLeakedInflightAtStartup ERROR: ${err.message}`);
  }
  return reaped;
}

// Remove detached sentinels whose recorded PID is dead. Returns the cleared issueIds.
export function reapDeadDetachedSentinels(): string[] {
  const { detachedDir, log } = requireDeps();
  const cleared: string[] = [];
  try {
    if (!fs.existsSync(detachedDir)) return cleared;
    for (const file of fs.readdirSync(detachedDir)) {
      if (!file.endsWith('.json')) continue;
      let record: DetachedSentinel | null = null;
      try {
        record = JSON.parse(fs.readFileSync(path.join(detachedDir, file), 'utf8'));
      } catch {
        record = null;
      }
      if (!record || !record.issueId) continue;
      if (record.pid == null) continue; // unknown pid: leave for the inflight-TTL path
      let isDead = false;
      try {
        process.kill(record.pid, 0);
      } catch (e: any) {
        if (e.code === 'ESRCH') isDead = true;
      }
      if (isDead) {
        clearDetachedSentinel(record.issueId);
        removeInflight(record.issueId);
        cleared.push(record.issueId);
      }
    }
    if (cleared.length > 0) {
      log('REAPER', `reapDeadDetachedSentinels: cleared ${cleared.length} finished detached run(s): ${cleared.join(', ')}`);
    }
  } catch (err: any) {
    log('REAPER', `reapDeadDetachedSentinels ERROR: ${err.message}`);
  }
  return cleared;
}

// SOT-915: detect detached long-run completion via the per-issue done-marker and feed the result
// back through the normal enqueue/Resume post-processing (processCompletedRun). This closes the
// "launch → complete → post-process" loop for detached runs without occupying Claude:
//   - exit 0 + verified   → success cleanup (clear cooldown / remove usage-limit label)
//   - usage-limit          → cooldown set + resume metadata saved + re-enqueued with retryAt
//   - non-zero / failed    → recorded (the abnormal exit is logged)
// A no-op while a run holds the lock. Each marker's outcome is applied once, then the marker, log,
// sentinel and inflight entry are cleared. Returns the issueIds processed.
export async function reapCompletedDetachedRuns(): Promise<string[]> {
  const { detachedDir, log, processCompletedRun, resolveLane, detachedOutcomeForKind } = requireDeps();
  if (isLocked()) return []; // never act mid-run
  const processed: string[] = [];
  if (!fs.existsSync(detachedDir)) return processed;
  let files: string[] = [];
  try {
    files = fs.readdirSync(detachedDir).filter(f => f.endsWith('.done.json'));
  } catch (err: any) {
    log('REAPER', `reapCompletedDetachedRuns readdir ERROR: ${err.message}`);
    return processed;
  }
  for (const file of files) {
    const fullPath = path.join(detachedDir, file);
    let issueId: string | null = null;
    try {
      let done: DetachedDone | null = null;
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (parsed && typeof parsed.issueId === 'string') {
          done = { issueId: parsed.issueId, exitCode: Number(parsed.exitCode), endedAt: parsed.endedAt };
        }
      } catch {
        done = null;
      }
      if (!done || !done.issueId) {
        // Unparseable / orphan marker: drop it so it doesn't accumulate.
        try { fs.unlinkSync(fullPath); } catch { /* ignore */ }
        log('REAPER', `reapCompletedDetachedRuns: dropped unparseable done-marker ${file}`);
        continue;
      }
      issueId = done.issueId;
      const exitCode = Number.isFinite(done.exitCode) ? done.exitCode : 1;
      const logFile = detachedLogFile(issueId);
      let runOutput = '';
      try {
        if (fs.existsSync(logFile)) runOutput = fs.readFileSync(logFile, 'utf8');
      } catch { /* ignore — empty output */ }

      // Minimal QueueItem for re-injection. Priority/parent grouping are intentionally null:
      // a usage-limit resume re-enqueue gets its priority refreshed from Linear on the next drain.
      const item: QueueItem = {
        issueId,
        issueIdentifier: null,
        trigger: 'detached',
        retryAt: null,
        enqueuedAt: new Date().toISOString(),
        lastAttemptAt: null,
        attemptCount: 0,
        reason: null,
        priority: null,
        priorityLabel: null,
        priorityRank: 0,
        linearFetchedAt: null,
        parentIssueId: null,
        parentIssueIdentifier: null,
        queueGroup: null,
        queueGroupOrder: null
      };

      const r = await processCompletedRun(item, exitCode, runOutput);
      await notifyDetachedCompleted({
        issueId,
        lane: resolveLane(),
        exitCode,
        outcome: detachedOutcomeForKind(r.resultKind)
      }).catch(() => {});
      log('REAPER', `reapCompletedDetachedRuns: post-processed detached completion exit=${exitCode}`, { issue: issueId });
      processed.push(issueId);
    } catch (err: any) {
      log('REAPER', `reapCompletedDetachedRuns ERROR for ${file}: ${err.message}`, issueId ? { issue: issueId } : undefined);
    } finally {
      // Clean up this completed run's tracking regardless of post-processing outcome.
      if (issueId) {
        clearDetachedDone(issueId);
        clearDetachedLog(issueId);
        clearDetachedSentinel(issueId);
        removeInflight(issueId);
      }
    }
  }
  return processed;
}

// --- Stall watchdog (design/README.md §34 停滞検出と Watchdog) --------------------------------
// Long runs have no wall-clock timeout; the substitute is activity-based stall detection. A live
// detached run whose per-issue log has not grown/been touched for RUNNER_WATCHDOG_STALL_MS is
// "alive but not progressing": warn (the log line is mirrored to Discord by the webhook server).
// Past RUNNER_WATCHDOG_KILL_MS the run is presumed hung and is killed; the existing reapers then
// recover it without a human (dead sentinel → sentinel+inflight cleared → the stranded-issue rescan
// re-enqueues the issue for a fresh attempt). kill=0 disables the kill escalation.

export interface StalledDetachedRun {
  issueId: string;
  pid: number;
  lastActivityAt: string;
  stalledForMs: number;
  killed: boolean;
}

const DEFAULT_WATCHDOG_STALL_MS = 2 * 60 * 60 * 1000; // 2h without output → warn
const DEFAULT_WATCHDOG_KILL_MS = 12 * 60 * 60 * 1000; // 12h without output → presume hung, kill

function watchdogEnvMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

// Re-warn at most once per stall window per issue so the reaper tick does not spam.
const lastStallWarnAt = new Map<string, number>();

/** Test helper. */
export function clearStallWarnings(): void {
  lastStallWarnAt.clear();
}

export function runDetachedWatchdog(
  opts: { stallMs?: number; killMs?: number; now?: number } = {}
): StalledDetachedRun[] {
  const { detachedDir, log } = requireDeps();
  const now = opts.now ?? Date.now();
  const stallMs = opts.stallMs ?? watchdogEnvMs('RUNNER_WATCHDOG_STALL_MS', DEFAULT_WATCHDOG_STALL_MS);
  const killMs = opts.killMs ?? watchdogEnvMs('RUNNER_WATCHDOG_KILL_MS', DEFAULT_WATCHDOG_KILL_MS);
  const stalled: StalledDetachedRun[] = [];
  if (stallMs <= 0) return stalled; // watchdog disabled
  try {
    if (!fs.existsSync(detachedDir)) return stalled;
    for (const file of fs.readdirSync(detachedDir)) {
      if (!file.endsWith('.json') || file.endsWith('.done.json')) continue;
      let sentinel: DetachedSentinel | null = null;
      try {
        sentinel = JSON.parse(fs.readFileSync(path.join(detachedDir, file), 'utf8'));
      } catch {
        continue;
      }
      if (!sentinel?.issueId || sentinel.pid == null) continue;
      try {
        process.kill(sentinel.pid, 0);
      } catch {
        continue; // dead PID: reapDeadDetachedSentinels owns that path
      }

      let lastActivityMs = Date.parse(sentinel.startedAt || '') || 0;
      try {
        const logStat = fs.statSync(detachedLogFile(sentinel.issueId));
        lastActivityMs = Math.max(lastActivityMs, logStat.mtimeMs);
      } catch { /* no log yet — fall back to startedAt */ }
      if (!lastActivityMs) continue;

      const stalledForMs = now - lastActivityMs;
      if (stalledForMs < stallMs) {
        lastStallWarnAt.delete(sentinel.issueId);
        continue;
      }

      let killed = false;
      if (killMs > 0 && stalledForMs >= killMs) {
        try {
          process.kill(sentinel.pid, 'SIGTERM');
          killed = true;
          log('WATCHDOG', `stalled detached run presumed hung — killed pid=${sentinel.pid} after ${Math.round(stalledForMs / 60000)}min without output (reapers will recover and re-enqueue)`, { issue: sentinel.issueId });
        } catch (err: any) {
          log('WATCHDOG', `stalled detached run kill failed: ${err.message}`, { issue: sentinel.issueId });
        }
      } else {
        const lastWarn = lastStallWarnAt.get(sentinel.issueId) ?? 0;
        if (now - lastWarn >= stallMs) {
          lastStallWarnAt.set(sentinel.issueId, now);
          log('WATCHDOG', `detached run alive (pid=${sentinel.pid}) but no output for ${Math.round(stalledForMs / 60000)}min — possible stall (kill after ${killMs > 0 ? Math.round(killMs / 60000) + 'min' : 'disabled'})`, { issue: sentinel.issueId });
        }
      }
      stalled.push({
        issueId: sentinel.issueId,
        pid: sentinel.pid,
        lastActivityAt: new Date(lastActivityMs).toISOString(),
        stalledForMs,
        killed,
      });
    }
  } catch (err: any) {
    log('WATCHDOG', `runDetachedWatchdog ERROR: ${err.message}`);
  }
  return stalled;
}

export function addInflight(issueId: string): void {
  const records = loadInflightRecords();
  if (!records.some(r => r.issueId === issueId)) {
    records.push({ issueId, startedAt: new Date().toISOString() });
    saveInflightRecords(records);
  }
}

export function removeInflight(issueId: string): void {
  const records = loadInflightRecords().filter(r => r.issueId !== issueId);
  saveInflightRecords(records);
}

export function isInflight(issueId: string): boolean {
  return loadInflight().includes(issueId);
}

// --- Detached long-run sentinels (SOT-914) -------------------------------------------------
// A sentinel marks an issue whose run was launched detached (the heavy process keeps running
// after the JS lock is released). The reaper clears sentinels for dead PIDs / reaped inflight.

interface DetachedSentinel {
  issueId: string;
  pid: number | null;
  startedAt: string;
}

export function sanitizeIssueIdForFile(issueId: string): string {
  return issueId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function detachedSentinelFile(issueId: string): string {
  return path.join(requireDeps().detachedDir, `${sanitizeIssueIdForFile(issueId)}.json`);
}

export function writeDetachedSentinel(issueId: string, pid: number | undefined): void {
  const { detachedDir, log } = requireDeps();
  try {
    if (!fs.existsSync(detachedDir)) fs.mkdirSync(detachedDir, { recursive: true });
    const record: DetachedSentinel = { issueId, pid: pid ?? null, startedAt: new Date().toISOString() };
    const target = detachedSentinelFile(issueId);
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, target);
  } catch (err: any) {
    log('RUNNER', `writeDetachedSentinel ERROR: ${err.message}`, { issue: issueId });
  }
}

export function clearDetachedSentinel(issueId: string): void {
  const { log } = requireDeps();
  try {
    const target = detachedSentinelFile(issueId);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch (err: any) {
    log('RUNNER', `clearDetachedSentinel ERROR: ${err.message}`, { issue: issueId });
  }
}

export function loadDetachedSentinel(issueId: string): DetachedSentinel | null {
  try {
    const target = detachedSentinelFile(issueId);
    if (!fs.existsSync(target)) return null;
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}

// --- Detached completion done-markers (SOT-915) --------------------------------------------
// A detached long-run (SOT-914) is launched fully detached: the parent JS process may not be
// alive when the heavy run finishes, so the child itself records its outcome durably. On exit
// the child writes a per-issue log (its stdout+stderr) and a done-marker carrying the exit code.
// The completion reaper consumes these and re-injects the result into the normal enqueue/Resume
// post-processing (see reapCompletedDetachedRuns).

interface DetachedDone {
  issueId: string;
  exitCode: number;
  endedAt: string;
}

export function detachedLogFile(issueId: string): string {
  return path.join(requireDeps().detachedDir, `${sanitizeIssueIdForFile(issueId)}.log`);
}

export function detachedDoneFile(issueId: string): string {
  return path.join(requireDeps().detachedDir, `${sanitizeIssueIdForFile(issueId)}.done.json`);
}

export function loadDetachedDone(issueId: string): DetachedDone | null {
  try {
    const target = detachedDoneFile(issueId);
    if (!fs.existsSync(target)) return null;
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!parsed || typeof parsed.issueId !== 'string') return null;
    return { issueId: parsed.issueId, exitCode: Number(parsed.exitCode), endedAt: parsed.endedAt };
  } catch {
    return null;
  }
}

export function clearDetachedDone(issueId: string): void {
  const { log } = requireDeps();
  try {
    const target = detachedDoneFile(issueId);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch (err: any) {
    log('RUNNER', `clearDetachedDone ERROR: ${err.message}`, { issue: issueId });
  }
}

export function clearDetachedLog(issueId: string): void {
  const { log } = requireDeps();
  try {
    const target = detachedLogFile(issueId);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch (err: any) {
    log('RUNNER', `clearDetachedLog ERROR: ${err.message}`, { issue: issueId });
  }
}
