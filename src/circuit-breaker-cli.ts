'use strict';

/**
 * SOT-1560 — thin CLI wrapper around `evaluateBreaker`, the single source of truth the shell
 * (`scripts/ai/run_auto.sh`) uses to check the circuit breaker each pipeline cycle. Pure decision only
 * (no network / no Linear); the shell performs the halt side-effects (notify + move-on-hold). Prints a
 * one-line, shell-parseable decision to stdout and exits 0 when NOT tripped, 10 when tripped:
 *
 *   TRIPPED=<true|false> BREAKER=<name|-> REASON=<text>
 *
 * Env / config inputs:
 *   CB_CONFIG               : path to circuit_breaker.json (default config/circuit_breaker.json)
 *   CB_STARTED_AT_MS        : epoch ms the issue pipeline started (empty ⇒ unknown)
 *   CB_NOW_MS               : current epoch ms (default Date.now())
 *   CB_CONSECUTIVE_FAILURES : consecutive same-role failures
 *   CB_TOKENS_USED          : approximate tokens consumed for this issue
 *   CB_NO_PROGRESS_CYCLES   : consecutive cycles with no diff/commit/report change
 *
 * Fail-open on config read/parse error: emit TRIPPED=false so a broken config never wedges the pipeline
 * (the breaker is a safety add-on, disabled by default).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { evaluateBreaker, type BreakerConfig, type BreakerState } from './lib/circuitBreaker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const num = (v: string | undefined): number | null => {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function loadConfig(): Partial<BreakerConfig> | null {
  const configPath = process.env.CB_CONFIG || path.join(__dirname, '..', 'config', 'circuit_breaker.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw) as Partial<BreakerConfig>;
  } catch {
    return null; // fail-open: missing/invalid config ⇒ disabled breaker
  }
}

const state: BreakerState = {
  startedAtMs: num(process.env.CB_STARTED_AT_MS),
  nowMs: num(process.env.CB_NOW_MS) ?? Date.now(),
  consecutiveFailures: num(process.env.CB_CONSECUTIVE_FAILURES),
  tokensUsed: num(process.env.CB_TOKENS_USED),
  noProgressCycles: num(process.env.CB_NO_PROGRESS_CYCLES),
};

const config = loadConfig();
// Fail-open on unreadable config: an absent config means "no breaker configured" ⇒ not tripped.
const decision = config == null
  ? { tripped: false, breaker: null, reason: 'no circuit_breaker.json — breaker disabled' }
  : evaluateBreaker(state, config);

process.stdout.write(
  `TRIPPED=${decision.tripped} BREAKER=${decision.breaker ?? '-'} REASON=${decision.reason ?? 'within all stop conditions'}`,
);
process.exit(decision.tripped ? 10 : 0);
