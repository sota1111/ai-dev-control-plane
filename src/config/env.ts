/**
 * Centralized, typed accessors for all NON-SECRET tunable environment knobs.
 *
 * This is the single source of truth for the runtime tunables (numeric/boolean/
 * string defaults) that used to be read inline via `parseInt(process.env.X || '...')`
 * scattered across runner.ts / webhook-server.ts / usageLimitParser.ts. Each knob's
 * env var name and default value now lives here, in one place.
 *
 * Secrets (LINEAR_API_KEY, DISCORD_WEBHOOK_URL, the Secret Manager backend, etc.)
 * are intentionally NOT handled here — they remain in `src/config/secrets.js`
 * (`getSecret`), which layers Secret Manager over process.env.
 *
 * Every accessor reads from the supplied env (default `process.env`) at CALL TIME.
 * This is deliberate: tests mutate `process.env` between cases, and some call sites
 * inject an env object. Do not cache values at module load.
 */

type Env = NodeJS.ProcessEnv;

/**
 * Parse an integer env var, mirroring the historical `parseInt(env.X || 'def', 10)`
 * semantics byte-for-byte — including yielding NaN for non-numeric input (callers
 * relied on this, so no Number.isFinite fallback is applied).
 */
function intEnv(env: Env, name: string, def: number): number {
  return parseInt(env[name] || String(def), 10);
}

/** USAGE_LIMIT_RETRY_BUFFER_SECONDS — buffer added past a parsed usage-limit reset (default 600s). */
export function usageLimitRetryBufferSeconds(env: Env = process.env): number {
  return intEnv(env, 'USAGE_LIMIT_RETRY_BUFFER_SECONDS', 600);
}

/** OVERLOAD_RETRY_BUFFER_SECONDS — buffer for transient overload/503 retries (default 3600s). */
export function overloadRetryBufferSeconds(env: Env = process.env): number {
  return intEnv(env, 'OVERLOAD_RETRY_BUFFER_SECONDS', 3600);
}

/** LOCK_CONFLICT_BACKOFF_MS — re-enqueue backoff when run_auto.sh flock is held (default 60000ms). */
export function lockConflictBackoffMs(env: Env = process.env): number {
  return intEnv(env, 'LOCK_CONFLICT_BACKOFF_MS', 60000);
}

/** QUEUE_ITEM_TTL_DAYS — max age before a queued item is pruned (default 7 days). */
export function queueItemTtlDays(env: Env = process.env): number {
  return intEnv(env, 'QUEUE_ITEM_TTL_DAYS', 7);
}

/** INFLIGHT_TTL_MS — max age before a leaked inflight entry is reaped (default 2h). */
export function inflightTtlMs(env: Env = process.env): number {
  return intEnv(env, 'INFLIGHT_TTL_MS', 2 * 60 * 60 * 1000);
}

/** LONG_RUN_LABEL — Linear label that triggers detached long-run execution (default 'long-run'). */
export function longRunLabel(env: Env = process.env): string {
  return env.LONG_RUN_LABEL || 'long-run';
}

/** QUEUE_DRAIN_INTERVAL_MS — periodic queue drain interval in the webhook server (default 300000ms). */
export function queueDrainIntervalMs(env: Env = process.env): number {
  return intEnv(env, 'QUEUE_DRAIN_INTERVAL_MS', 300000);
}

/** REAPER_STRANDED_MAX_INTERVAL_MS — max interval between stranded In-Progress rescans (default 300000ms). */
export function reaperStrandedMaxIntervalMs(env: Env = process.env): number {
  return intEnv(env, 'REAPER_STRANDED_MAX_INTERVAL_MS', 300000);
}

/** PORT — webhook server listen port (default 3000). Returns string|number, matching the historical `env.PORT || 3000`. */
export function port(env: Env = process.env): string | number {
  return env.PORT || 3000;
}

/** WEBHOOK_REAPER_ENABLED — reaper is on by default; only the literal 'false' disables it. */
export function webhookReaperEnabled(env: Env = process.env): boolean {
  return env.WEBHOOK_REAPER_ENABLED !== 'false';
}

/** WEBHOOK_BOOTSTRAP_SCAN_ENABLED — bootstrap scan is on by default; only the literal 'false' disables it. */
export function webhookBootstrapScanEnabled(env: Env = process.env): boolean {
  return env.WEBHOOK_BOOTSTRAP_SCAN_ENABLED !== 'false';
}
