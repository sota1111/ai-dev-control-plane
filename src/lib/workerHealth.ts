'use strict';

import fs from 'node:fs';
import path from 'node:path';

/**
 * SOT-1441 / P1 — worker availability classification + auth-unhealthy marker.
 *
 * The single biggest operational pain is that ~81% of runs fall back to Claude because a worker is
 * non-responsive (Codex usage-limit cooldown ~56% / Antigravity auth failure ~25%). Those two causes
 * are fundamentally different:
 *   - usage_limit is TRANSIENT (auto-recovers at a known reset epoch → handled by the cooldown file).
 *   - auth_failure is CHRONIC (needs a human to re-authenticate; retrying just re-hits the same error).
 *
 * This module (a) classifies a worker run's failure and (b) manages a short-TTL "auth-unhealthy"
 * marker (symmetric to the usage-limit cooldown file) so that, once an auth failure is detected, the
 * next runs SKIP invoking the CLI for a window instead of paying the full failed-invocation cost each
 * time — and so the alert can be separated (chronic vs transient).
 */

export type WorkerName = 'antigravity' | 'codex';
export type WorkerFailureKind = 'ok' | 'usage_limit' | 'auth_failure' | 'timeout' | 'crash';

// Transient usage/quota limits (checked first — a report can mention "auth" while really being a limit).
const USAGE_LIMIT_RE =
  /usage limit|quota exceeded|resource exhausted|rate limit|resource_exhausted|try again at|resets at|exhausted your daily quota|daily quota|429|too many requests|please retry in/i;

// Chronic authentication failures that a human must fix (re-login / new token).
const AUTH_FAILURE_RE =
  /authentication failed|auth failed|authentication .*timed out|not logged in|please log ?in|log ?in required|login required|unauthorized|invalid credentials|no credentials|token expired|re-?authenticate|reauth|401 /i;

/**
 * Classify a finished worker run from its combined stdout/stderr and exit code.
 * exitCode 0 → 'ok'. Otherwise usage_limit > auth_failure > timeout(124) > crash.
 */
export function classifyWorkerFailure(output: string, exitCode: number): WorkerFailureKind {
  if (exitCode === 0) return 'ok';
  const text = output || '';
  if (USAGE_LIMIT_RE.test(text)) return 'usage_limit';
  if (AUTH_FAILURE_RE.test(text)) return 'auth_failure';
  if (exitCode === 124) return 'timeout';
  return 'crash';
}

/** Chronic = needs human intervention (auth). Transient causes recover on their own. */
export function isChronic(kind: WorkerFailureKind): boolean {
  return kind === 'auth_failure';
}

export function authUnhealthyFile(worker: WorkerName, dir: string): string {
  return path.join(dir, `${worker}.auth_unhealthy.json`);
}

export interface AuthUnhealthyStatus {
  active: boolean;
  expiresAtEpoch: number | null; // seconds
  remainingSeconds: number | null;
}

/** Read the auth-unhealthy marker for a worker. Active only while now < expiresAtEpoch. Never throws. */
export function readAuthUnhealthy(worker: WorkerName, dir: string, nowMs: number = Date.now()): AuthUnhealthyStatus {
  const inactive: AuthUnhealthyStatus = { active: false, expiresAtEpoch: null, remainingSeconds: null };
  try {
    const file = authUnhealthyFile(worker, dir);
    if (!fs.existsSync(file)) return inactive;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const expiresAtEpoch = Number(data.expiresAtEpoch);
    if (!Number.isFinite(expiresAtEpoch) || expiresAtEpoch * 1000 <= nowMs) return inactive;
    return {
      active: true,
      expiresAtEpoch,
      remainingSeconds: Math.max(0, expiresAtEpoch - Math.floor(nowMs / 1000)),
    };
  } catch {
    return inactive;
  }
}

/**
 * SOT-1548 — the single decision behind run_antigravity.sh's pre-run gate: should we SKIP launching the
 * worker CLI (and hand off immediately) because the auth-unhealthy marker is still fresh? True iff the
 * marker is active. Exposed as a named function — instead of the shell re-parsing the marker with its
 * own inline `node -e` one-liner — so the pre-run gate and the marker writer (writeAuthUnhealthy) share
 * one source of truth and cannot drift on path/parsing/expiry (the ~40s-probe hole seen in SOT-1533).
 */
export function shouldSkipForAuthUnhealthy(
  worker: WorkerName,
  dir: string,
  nowMs: number = Date.now()
): boolean {
  return readAuthUnhealthy(worker, dir, nowMs).active;
}

/** Write/refresh the auth-unhealthy marker with a TTL. Returns the expiry epoch (seconds). Never throws. */
export function writeAuthUnhealthy(
  worker: WorkerName,
  dir: string,
  ttlSeconds: number,
  nowMs: number = Date.now()
): number {
  const expiresAtEpoch = Math.floor(nowMs / 1000) + Math.max(1, Math.floor(ttlSeconds));
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      authUnhealthyFile(worker, dir),
      JSON.stringify({ expiresAtEpoch, detectedAt: new Date(nowMs).toISOString(), reason: `${worker}_auth_failure` }, null, 2)
    );
  } catch {
    /* best-effort */
  }
  return expiresAtEpoch;
}

/** Clear a worker's auth-unhealthy marker (called once the worker authenticates successfully). */
export function clearAuthUnhealthy(worker: WorkerName, dir: string): void {
  try {
    const file = authUnhealthyFile(worker, dir);
    if (fs.existsSync(file)) fs.rmSync(file);
  } catch {
    /* best-effort */
  }
}
