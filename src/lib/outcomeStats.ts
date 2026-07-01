/**
 * SOT-1439 / P5 — observability for runner outcomes.
 *
 * Parses the structured `[OUTCOME]` lines emitted by runner.processCompletedRun and produces
 * aggregate stats (counts + rates) so we can measure success rate, usage-limit rate, and failure
 * rate over a time window. Pure functions (no I/O) so they are trivially testable and reused by
 * both the daily aggregation CLI (`scripts/ai/aggregate_outcomes.mjs`) and the Discord `/status`
 * "recent outcomes" summary.
 *
 * Log line shape (see runner.ts `log()`):
 *   [YYYY-MM-DD HH:MM:SS] [OUTCOME] issue=SOT-1 trigger=webhook outcome=TASK_COMPLETED code=0 run outcome TASK_COMPLETED
 */

export interface OutcomeRecord {
  /** ISO-ish timestamp string as logged ("YYYY-MM-DD HH:MM:SS"), or null if unparseable. */
  timestamp: string | null;
  /** Epoch ms of the timestamp (UTC — the logger writes ISO/UTC), or null. */
  epochMs: number | null;
  issue: string | null;
  trigger: string | null;
  /** Outcome kind, e.g. TASK_COMPLETED / COMPLETION_UNVERIFIED / USAGE_LIMIT_RETRY / FAILED. */
  outcome: string;
  code: number | null;
}

export interface OutcomeSummary {
  total: number;
  byOutcome: Record<string, number>;
  /** TASK_COMPLETED / total (0 when total is 0). */
  successRate: number;
  /** USAGE_LIMIT_RETRY + NON_RETRYABLE_LIMIT / total. */
  usageLimitRate: number;
  /** FAILED / total. */
  failureRate: number;
}

const OUTCOME_LINE = /\[([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2})\]\s+\[OUTCOME\]\s+(.*)$/;

function parseKv(rest: string): Record<string, string> {
  const kv: Record<string, string> = {};
  // Match key=value tokens (value = non-space run). Trailing free-text message is ignored.
  const re = /(\w+)=([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    if (!(m[1] in kv)) kv[m[1]] = m[2];
  }
  return kv;
}

/** Parse all `[OUTCOME]` lines from a log blob into structured records. Non-outcome lines are ignored. */
export function parseOutcomeLines(text: string): OutcomeRecord[] {
  const records: OutcomeRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = OUTCOME_LINE.exec(line);
    if (!m) continue;
    const timestamp = m[1];
    const kv = parseKv(m[2]);
    if (!kv.outcome) continue;
    // Logger writes `new Date().toISOString()` with 'T'→' ' and millis stripped; treat as UTC.
    const epochMs = Number.isNaN(Date.parse(timestamp + 'Z')) ? null : Date.parse(timestamp + 'Z');
    const code = kv.code !== undefined && /^-?\d+$/.test(kv.code) ? parseInt(kv.code, 10) : null;
    records.push({
      timestamp,
      epochMs,
      issue: kv.issue ?? null,
      trigger: kv.trigger ?? null,
      outcome: kv.outcome,
      code,
    });
  }
  return records;
}

/**
 * Summarize outcome records. `opts.sinceMs` (epoch ms) keeps only records at/after that instant
 * (records with a null epoch are kept — better to over-count than silently drop). `opts.now` is
 * unused here but reserved for callers computing windows.
 */
export function summarizeOutcomes(
  records: OutcomeRecord[],
  opts: { sinceMs?: number } = {}
): OutcomeSummary {
  const filtered = opts.sinceMs !== undefined
    ? records.filter((r) => r.epochMs === null || r.epochMs >= opts.sinceMs!)
    : records;

  const byOutcome: Record<string, number> = {};
  for (const r of filtered) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
  }
  const total = filtered.length;
  const get = (k: string) => byOutcome[k] || 0;
  const rate = (n: number) => (total === 0 ? 0 : n / total);

  return {
    total,
    byOutcome,
    successRate: rate(get('TASK_COMPLETED')),
    usageLimitRate: rate(get('USAGE_LIMIT_RETRY') + get('NON_RETRYABLE_LIMIT')),
    failureRate: rate(get('FAILED')),
  };
}

/** Format a summary as a compact one-line human string (used by Discord /status and the CLI). */
export function formatOutcomeSummary(summary: OutcomeSummary): string {
  if (summary.total === 0) return 'なし（記録なし）';
  const pct = (r: number) => `${Math.round(r * 100)}%`;
  const parts = Object.entries(summary.byOutcome)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}=${n}`);
  return `${summary.total}件 (成功 ${pct(summary.successRate)} / usage-limit ${pct(summary.usageLimitRate)} / 失敗 ${pct(summary.failureRate)}) — ${parts.join(', ')}`;
}
