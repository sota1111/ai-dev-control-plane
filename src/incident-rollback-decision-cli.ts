'use strict';

/**
 * SOT-1520 (REOPEN#4) — thin CLI wrapper around `classifyFailure` + `decideRollback`, so the shell
 * orchestrator (`scripts/ai/incident_response.sh`) does not re-implement the "is this error
 * update-related?" gate. Reads the incident signal from env and prints a one-line, shell-parseable
 * decision to stdout:
 *
 *   ROLLBACK=<true|false> UPDATE_RELATED=<true|false> CLASS=<failureClass> REASON=<text>
 *
 * Env inputs:
 *   HTTP_STATUS  : last probe HTTP status (empty / non-numeric ⇒ no response ⇒ unreachable)
 *   EXPECT_STATUS: expected status (default 200)
 *   ROLLBACK_ON  : comma-separated failure classes to allow (empty ⇒ default server-error,unreachable,not-found)
 *   CORRELATION_WINDOW_MS : deploy-correlation window ms (0/empty ⇒ disabled)
 *   DEPLOYED_AT  : ISO time the current revision was deployed (empty ⇒ unknown ⇒ correlation skipped)
 *   DETECTED_AT  : ISO time the incident was detected
 */

import {
  classifyFailure,
  decideRollback,
  type FailureClass,
  type ProbeResult,
} from './lib/incidentResponse.js';

const num = (v: string | undefined): number | null => {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const httpStatus = num(process.env.HTTP_STATUS);
const expectStatus = num(process.env.EXPECT_STATUS) || 200;

const probe: ProbeResult = {
  ok: httpStatus === expectStatus,
  // status 0 (curl failure sentinel from the shell) is treated as "no response" ⇒ unreachable.
  httpStatus: httpStatus === 0 ? null : httpStatus,
  latencyMs: null,
};

const rollbackOn = (process.env.ROLLBACK_ON || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean) as FailureClass[];

const failureClass = classifyFailure(probe, expectStatus);
const decision = decideRollback({
  failureClass,
  policy: {
    rollbackOn: rollbackOn.length > 0 ? rollbackOn : undefined,
    deployCorrelationWindowMs: num(process.env.CORRELATION_WINDOW_MS) || 0,
  },
  currentRevisionDeployedAt: process.env.DEPLOYED_AT || null,
  detectedAt: process.env.DETECTED_AT || new Date().toISOString(),
});

// Single-line, shell-parseable. REASON is last and unquoted so `cut -d' ' -f4-` recovers it verbatim.
process.stdout.write(
  `ROLLBACK=${decision.rollback} UPDATE_RELATED=${decision.updateRelated} CLASS=${decision.failureClass} REASON=${decision.reason}`
);
