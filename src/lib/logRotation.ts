/**
 * SOT-1421 — runner log rotation + levels (revamp of the P5 logging subsystem).
 *
 * The runner previously appended every line to a single, unbounded `auto_runner.log` with no
 * severity concept (grew to ~21MB). This module adds two non-breaking capabilities used by
 * `runner.ts`'s `log()`:
 *   1. Log LEVELS — derive a level from the existing free-form tag and filter below a threshold.
 *   2. Size-based ROTATION — shift `auto_runner.log` → `.1` → `.2` … keeping at most `maxFiles`
 *      generations, so the log never grows unbounded.
 *
 * The log line TEXT format is intentionally unchanged (outcomeStats.ts's regex depends on it).
 * Everything here is fail-open: logging must never throw into its callers.
 */

import * as nodeFs from 'fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Parse a LOG_LEVEL string. Trims/lowercases; anything invalid or undefined falls back to 'info'. */
export function parseLogLevel(s?: string): LogLevel {
  const v = (s ?? '').trim().toLowerCase();
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
  return 'info';
}

/**
 * Map a log tag to a severity level. Existing tags keep working: `ERROR`→error, `WARN`→warn,
 * `DEBUG`→debug, and everything else (RUNNER / RUN / OUTCOME / …) → info. Case-insensitive.
 */
export function levelForTag(tag: string): LogLevel {
  const t = (tag ?? '').toUpperCase();
  if (t === 'ERROR') return 'error';
  if (t === 'WARN') return 'warn';
  if (t === 'DEBUG') return 'debug';
  return 'info';
}

/** True when `level` is at or above the configured `threshold`. */
export function shouldLog(level: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[threshold];
}

/**
 * Rotate `logFile` when it has grown to/past `maxBytes`, keeping at most `maxFiles` generations
 * (`logFile`, `logFile.1`, … `logFile.{maxFiles-1}`). Fail-open: never throws; returns true only
 * when a rotation actually happened. `maxBytes <= 0` disables rotation.
 */
export function rotateIfNeeded(
  logFile: string,
  maxBytes: number,
  maxFiles: number,
  fsMod: typeof nodeFs = nodeFs
): boolean {
  try {
    if (!(maxBytes > 0)) return false;
    if (!fsMod.existsSync(logFile)) return false;
    if (fsMod.statSync(logFile).size < maxBytes) return false;

    const keep = Math.max(1, Math.floor(maxFiles));
    // Drop the overflow generation first so total generations never exceed `keep`.
    const overflow = `${logFile}.${keep}`;
    if (fsMod.existsSync(overflow)) {
      fsMod.rmSync(overflow, { force: true });
    }
    // Shift older generations up: .(keep-1) → .keep, … , .1 → .2
    for (let i = keep - 1; i >= 1; i--) {
      const src = `${logFile}.${i}`;
      if (fsMod.existsSync(src)) {
        fsMod.renameSync(src, `${logFile}.${i + 1}`);
      }
    }
    // Current file becomes .1; a fresh `logFile` is created lazily on the next append.
    fsMod.renameSync(logFile, `${logFile}.1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Existing log files newest→oldest: `[logFile, logFile.1, … logFile.maxFiles]` filtered to those
 * that exist. Used to read `[OUTCOME]` history across rotation so P5 stats survive a rotate.
 */
export function listLogFilesNewestFirst(
  logFile: string,
  maxFiles: number,
  fsMod: typeof nodeFs = nodeFs
): string[] {
  const keep = Math.max(1, Math.floor(maxFiles));
  const candidates = [logFile];
  for (let i = 1; i <= keep; i++) candidates.push(`${logFile}.${i}`);
  try {
    return candidates.filter((p) => fsMod.existsSync(p));
  } catch {
    return fsMod.existsSync(logFile) ? [logFile] : [];
  }
}
