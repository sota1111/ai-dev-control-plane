import fs from 'node:fs';
import path from 'node:path';

/**
 * SOT-1547: stop the webhook-reaper / bootstrap scan from re-enqueuing a run that ended with
 * code=70 (COMPLETION_UNVERIFIED = human-wait: BLOCKED / NEEDS_USER_INPUT) when no new human input
 * has arrived.
 *
 * Without this, a code=70 run leaves its issue in Todo/In Progress, so the reaper re-enqueues it on
 * every stranded-scan tick (~5 min). Since the result cannot change until a human comments / changes
 * state, this burns the account-global usage limit with zero progress (observed: SOT-1531 re-run 10x
 * in one day, parent SOT-1537 P1-2).
 *
 * Mechanism: record each code=70 termination per issue (`count` + `lastAt`). The reaper skips an issue
 * while it is inside an exponential-backoff window; once `count` exceeds `maxRetries` it is suppressed
 * until a human webhook (new comment / state change) clears the entry. A successful (code=0) run clears
 * it too. ALL persistence is fail-open: on any IO/parse error we do NOT suppress, preserving the
 * historical always-re-enqueue behavior.
 */

export interface HumanWaitEntry {
  /** Linear issue identifier (e.g. SOT-1531) — same key the queue/reaper use. */
  issueId: string;
  /** Consecutive code=70 terminations since the last success / human input. */
  count: number;
  /** ISO timestamp of the most recent code=70 termination. */
  lastAt: string;
}

export interface SuppressionPolicy {
  /** Backoff window (ms) after the 1st code=70. */
  baseMs: number;
  /** Cap on a single backoff window (ms). */
  maxMs: number;
  /** After `count` exceeds this, suppress until a human webhook clears the entry. */
  maxRetries: number;
}

type EntryMap = Record<string, HumanWaitEntry>;

/** Exponential backoff window (ms) for the Nth (1-based) code=70 termination, capped at maxMs. */
export function backoffMs(count: number, policy: SuppressionPolicy): number {
  const n = Math.max(1, count);
  const exp = Math.min(n - 1, 30); // guard against Math.pow overflow / absurd windows
  const base = Number.isFinite(policy.baseMs) && policy.baseMs > 0 ? policy.baseMs : 0;
  const cap = Number.isFinite(policy.maxMs) && policy.maxMs > 0 ? policy.maxMs : base;
  return Math.min(base * Math.pow(2, exp), cap);
}

/**
 * Pure decision: should the reaper SKIP re-enqueuing this issue right now?
 * - no entry            -> false (never suppress an issue that hasn't hit code=70)
 * - count > maxRetries  -> true  (retries exhausted; wait for human input)
 * - within backoff win  -> true
 * - otherwise           -> false (allow one backed-off retry)
 * Fail-open on an unparseable `lastAt`.
 */
export function shouldSuppressReaperEnqueue(
  entry: HumanWaitEntry | undefined | null,
  now: number,
  policy: SuppressionPolicy
): boolean {
  if (!entry) return false;
  if (policy.maxRetries >= 0 && entry.count > policy.maxRetries) return true;
  const last = new Date(entry.lastAt).getTime();
  if (!Number.isFinite(last)) return false; // fail-open
  return now - last < backoffMs(entry.count, policy);
}

/** When (ISO) the reaper may next re-enqueue this issue, or 'human-input' if retries are exhausted. */
export function nextEligibleAt(entry: HumanWaitEntry, policy: SuppressionPolicy): string {
  if (policy.maxRetries >= 0 && entry.count > policy.maxRetries) return 'human-input';
  const last = new Date(entry.lastAt).getTime();
  if (!Number.isFinite(last)) return 'now';
  return new Date(last + backoffMs(entry.count, policy)).toISOString();
}

// ---- durable store (fail-open) --------------------------------------------------------------

/** Load the suppression map. Fail-open: any missing/corrupt file yields an empty map. */
export function loadEntries(file: string): EntryMap {
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: EntryMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, any>)) {
      if (v && typeof v.issueId === 'string' && typeof v.count === 'number' && typeof v.lastAt === 'string') {
        out[k] = { issueId: v.issueId, count: v.count, lastAt: v.lastAt };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveEntries(file: string, map: EntryMap): void {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    /* fail-open: suppression bookkeeping must never throw into the run/webhook path */
  }
}

export function getEntry(file: string, issueId: string): HumanWaitEntry | undefined {
  return loadEntries(file)[issueId];
}

/** Record a code=70 (human-wait) termination for an issue; increments count, stamps lastAt. */
export function recordHumanWait(file: string, issueId: string, now: Date = new Date()): HumanWaitEntry {
  const map = loadEntries(file);
  const prev = map[issueId];
  const entry: HumanWaitEntry = {
    issueId,
    count: (prev?.count ?? 0) + 1,
    lastAt: now.toISOString(),
  };
  map[issueId] = entry;
  saveEntries(file, map);
  return entry;
}

/** Clear an issue's suppression (human input arrived, or it completed). Returns true if one existed. */
export function clearHumanWait(file: string, issueId: string): boolean {
  const map = loadEntries(file);
  if (!(issueId in map)) return false;
  delete map[issueId];
  saveEntries(file, map);
  return true;
}
