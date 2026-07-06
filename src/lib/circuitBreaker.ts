'use strict';

/**
 * SOT-1560 — circuit breaker / stop conditions for the role-driven pipeline (loop engineering lever 2).
 *
 * An unattended loop with no explicit stop condition can run away (burning tokens / cost) — retrying a
 * role forever, or spinning on an issue that makes no progress. This module supplies the *pure,
 * side-effect-free* decision core of a circuit breaker that `scripts/ai/run_auto.sh` consults each
 * pipeline cycle. The orchestration (measure elapsed time, count failures, move the issue to On Hold,
 * notify Linear) lives in the shell + a thin CLI; keeping the decision here makes it unit-testable.
 *
 * Four independent stop conditions (any one trips the breaker):
 *   - `max_runtime_min`          — wall-clock cap for a single issue pipeline (0 = disabled).
 *   - `max_consecutive_failures` — same role NEEDS_DEBUG / non-zero exit in a row (0 = disabled). This
 *                                   generalizes the old `PIPELINE_MAX_DEBUG_CYCLES` into one breaker.
 *   - `issue_token_budget`       — approximate token/cost budget for one issue (0 = disabled).
 *   - `no_progress`              — consecutive cycles with no diff/commit/report change (0 = disabled).
 *
 * Fail-safe (SOT-1560): if a condition is *enabled* (threshold > 0) but its required state value is
 * indeterminate (missing / non-finite), the breaker trips rather than silently continuing — an
 * unmeasurable loop is treated as unsafe. Defaults ship at 0 (disabled) so current behavior is a no-op
 * until each knob is enabled deliberately (staged rollout).
 */

export type BreakerName = 'max_runtime_min' | 'max_consecutive_failures' | 'issue_token_budget' | 'no_progress';

export interface BreakerConfig {
  max_runtime_min: number;
  max_consecutive_failures: number;
  issue_token_budget: number;
  no_progress: number;
}

/** Observed pipeline state at the moment the breaker is evaluated. */
export interface BreakerState {
  /** epoch ms the issue pipeline started; null/undefined ⇒ unknown. */
  startedAtMs?: number | null;
  /** current epoch ms (injected for deterministic tests). */
  nowMs: number;
  /** count of consecutive same-role failures (NEEDS_DEBUG / non-zero exit). */
  consecutiveFailures?: number | null;
  /** approximate tokens consumed so far for this issue. */
  tokensUsed?: number | null;
  /** count of consecutive cycles that produced no diff/commit/report change. */
  noProgressCycles?: number | null;
}

export interface BreakerDecision {
  /** whether the breaker tripped (pipeline should stop safely). */
  tripped: boolean;
  /** which condition tripped, or null when not tripped. */
  breaker: BreakerName | null;
  /** human-readable justification, recorded in the halt notification. */
  reason: string | null;
}

const DEFAULT_CONFIG: BreakerConfig = {
  max_runtime_min: 0,
  max_consecutive_failures: 0,
  issue_token_budget: 0,
  no_progress: 0,
};

/** A threshold is a non-negative integer; anything invalid/negative ⇒ 0 (disabled). */
function normThreshold(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * Normalize a raw config object (e.g. parsed `config/circuit_breaker.json`) into a full BreakerConfig,
 * filling missing/invalid knobs with the disabled default (0 = no-op). Unknown keys are ignored.
 */
export function normalizeConfig(raw: Partial<BreakerConfig> | null | undefined): BreakerConfig {
  const r = (raw || {}) as Record<string, unknown>;
  return {
    max_runtime_min: normThreshold(r.max_runtime_min),
    max_consecutive_failures: normThreshold(r.max_consecutive_failures),
    issue_token_budget: normThreshold(r.issue_token_budget),
    no_progress: normThreshold(r.no_progress),
  };
}

/** Elapsed whole minutes between a start epoch and now; null when either side is unknown/invalid. */
export function elapsedMinutes(startedAtMs: number | null | undefined, nowMs: number): number | null {
  if (startedAtMs == null || !Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return null;
  const ms = nowMs - startedAtMs;
  if (ms < 0) return 0;
  return Math.floor(ms / 60000);
}

/** True when the value is a usable finite number (used for the fail-safe gate). */
function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Evaluate all enabled stop conditions in priority order and return the first trip (or a not-tripped
 * decision when every enabled condition is within budget). A disabled condition (threshold 0) is never
 * consulted, so the all-zero default is a strict no-op.
 */
export function evaluateBreaker(state: BreakerState, rawConfig: Partial<BreakerConfig> | null | undefined): BreakerDecision {
  const cfg = normalizeConfig(rawConfig);
  const ok: BreakerDecision = { tripped: false, breaker: null, reason: null };

  // 1) runtime cap
  if (cfg.max_runtime_min > 0) {
    const mins = elapsedMinutes(state.startedAtMs, state.nowMs);
    if (mins == null) {
      return trip('max_runtime_min', `runtime is unmeasurable (start time unknown) but max_runtime_min=${cfg.max_runtime_min} is enabled — fail-safe stop`);
    }
    if (mins > cfg.max_runtime_min) {
      return trip('max_runtime_min', `pipeline ran ${mins}min > cap ${cfg.max_runtime_min}min — safe stop`);
    }
  }

  // 2) consecutive failures
  if (cfg.max_consecutive_failures > 0) {
    const fails = finiteOrNull(state.consecutiveFailures);
    if (fails == null) {
      return trip('max_consecutive_failures', `consecutive-failure count is unknown but max_consecutive_failures=${cfg.max_consecutive_failures} is enabled — fail-safe stop`);
    }
    if (fails >= cfg.max_consecutive_failures) {
      return trip('max_consecutive_failures', `${fails} consecutive role failures ≥ limit ${cfg.max_consecutive_failures} — safe stop`);
    }
  }

  // 3) token / cost budget
  if (cfg.issue_token_budget > 0) {
    const tokens = finiteOrNull(state.tokensUsed);
    if (tokens == null) {
      return trip('issue_token_budget', `token usage is unknown but issue_token_budget=${cfg.issue_token_budget} is enabled — fail-safe stop`);
    }
    if (tokens >= cfg.issue_token_budget) {
      return trip('issue_token_budget', `${tokens} tokens ≥ budget ${cfg.issue_token_budget} — safe stop`);
    }
  }

  // 4) no-progress
  if (cfg.no_progress > 0) {
    const noProg = finiteOrNull(state.noProgressCycles);
    if (noProg == null) {
      return trip('no_progress', `progress is unmeasurable but no_progress=${cfg.no_progress} is enabled — fail-safe stop`);
    }
    if (noProg >= cfg.no_progress) {
      return trip('no_progress', `${noProg} consecutive cycles with no diff/commit/report change ≥ limit ${cfg.no_progress} — safe stop`);
    }
  }

  return ok;
}

function trip(breaker: BreakerName, reason: string): BreakerDecision {
  return { tripped: true, breaker, reason };
}

export { DEFAULT_CONFIG };
