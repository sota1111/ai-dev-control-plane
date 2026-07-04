'use strict';

/**
 * SOT-1520 — production incident auto-response: pure classification + postmortem rendering.
 *
 * The prior capability answer (SOT-1520) established that the harness auto-handles *dev/CI worker*
 * failures (detect → root-cause → remediate → verify) but had **no** production-runtime incident
 * response: no health monitoring of a deployed service, no automatic rollback/degradation, and no
 * automatic postmortem. This module supplies the *testable, side-effect-free* core of that loop:
 *
 *   - `classifyProbe`        — one health probe → healthy | degraded | unhealthy
 *   - `shouldTriggerIncident`— consecutive-failure decision (N unhealthy in a row ⇒ incident)
 *   - `renderPostmortem`     — deterministic postmortem markdown from an incident record
 *
 * The orchestration (curl the endpoint, run the rollback command, write the postmortem file) lives in
 * `scripts/ai/incident_response.sh`, which is best-effort and OFF by default — real monitoring and
 * rollback need deploy-environment credentials that do not live in this repo. This split keeps the
 * decision logic here where it can be unit-tested.
 */

export type HealthState = 'healthy' | 'degraded' | 'unhealthy';

export interface ProbeResult {
  /** true when the request completed with the expected status. */
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  error?: string | null;
}

export interface ProbeThresholds {
  /** expected HTTP status (default 200 when 0/undefined). */
  expectStatus: number;
  /** latency (ms) above which an otherwise-OK probe is 'degraded'. 0/undefined disables the check. */
  maxLatencyMs: number;
}

/** Classify a single probe. Not OK / wrong status ⇒ unhealthy; OK but slow ⇒ degraded; else healthy. */
export function classifyProbe(result: ProbeResult, thresholds: ProbeThresholds): HealthState {
  const expect = thresholds.expectStatus || 200;
  if (!result.ok || result.httpStatus == null || result.httpStatus !== expect) {
    return 'unhealthy';
  }
  const max = thresholds.maxLatencyMs || 0;
  if (max > 0 && result.latencyMs != null && result.latencyMs > max) {
    return 'degraded';
  }
  return 'healthy';
}

/**
 * An incident is confirmed only when the last `threshold` probe states are ALL 'unhealthy' — a single
 * transient blip (or a merely 'degraded' state) must not trigger an automatic rollback.
 */
export function shouldTriggerIncident(history: HealthState[], threshold: number): boolean {
  const n = Math.max(1, Math.floor(threshold || 1));
  if (history.length < n) return false;
  return history.slice(-n).every((s) => s === 'unhealthy');
}

/**
 * Failure taxonomy used to decide whether an incident is *update-related* (i.e. plausibly caused by
 * the current deployment and therefore fixable by rolling back to the previous revision):
 *   - `server-error` (5xx)         — the deployed app itself is erroring ⇒ update-related.
 *   - `unreachable`  (no response) — connection refused / reset / timeout / DNS ⇒ a broken deploy that
 *                                    never came up ⇒ update-related.
 *   - `not-found`    (404)         — a route the deploy removed/renamed ⇒ update-related.
 *   - `client-error` (other 4xx)   — 400/401/403/429 etc.: auth / rate-limit / bad request. Rolling
 *                                    back the deployment does NOT fix these ⇒ NOT update-related.
 *   - `unknown`      (other)       — unexpected 2xx/3xx or anything else; not attributed to the update.
 */
export type FailureClass = 'server-error' | 'unreachable' | 'not-found' | 'client-error' | 'unknown';

/** Failure classes treated as update-related (rollback-eligible) by default. */
export const DEFAULT_ROLLBACK_ON: FailureClass[] = ['server-error', 'unreachable', 'not-found'];

/**
 * Classify *why* a probe failed, so rollback can be limited to update-related errors. A probe that is
 * `ok` and matched the expected status is not a failure ⇒ `unknown` (no rollback).
 */
export function classifyFailure(result: ProbeResult, expectStatus: number): FailureClass {
  const expect = expectStatus || 200;
  // No HTTP response at all (curl error, connection refused, timeout, DNS) → the service is unreachable.
  if (result.httpStatus == null) return 'unreachable';
  const s = result.httpStatus;
  if (s >= 500 && s <= 599) return 'server-error';
  if (s === 404) return 'not-found';
  if (s >= 400 && s <= 499) return 'client-error';
  // Any other status that isn't the expected one is unexpected but not obviously update-related.
  if (s !== expect) return 'unknown';
  return 'unknown';
}

export interface RollbackPolicy {
  /** failure classes considered update-related ⇒ rollback-eligible. Defaults to DEFAULT_ROLLBACK_ON. */
  rollbackOn?: FailureClass[];
  /**
   * ms after the current revision was deployed within which a failure is attributed to that deploy.
   * 0 / undefined disables the correlation gate (error-class gate alone decides).
   */
  deployCorrelationWindowMs?: number;
}

export interface RollbackDecisionInput {
  failureClass: FailureClass;
  policy: RollbackPolicy;
  /** ISO time the current (serving) revision was deployed, or null/undefined if unknown. */
  currentRevisionDeployedAt?: string | null;
  /** ISO time the incident was detected. */
  detectedAt: string;
}

export interface RollbackDecision {
  /** whether an automatic rollback should be executed for this incident. */
  rollback: boolean;
  /** whether the incident is attributed to the current update/deployment. */
  updateRelated: boolean;
  failureClass: FailureClass;
  /** human-readable justification, recorded in the postmortem. */
  reason: string;
}

/**
 * Decide whether to roll back, limiting rollback to *update-related* errors (SOT-1520 REOPEN#4).
 *
 * Two gates:
 *   1. **Error-class gate** — only failure classes in `rollbackOn` (default: server-error / unreachable
 *      / not-found) are update-related. Client errors (4xx auth/rate/bad-request) and unknown states
 *      are NOT fixed by reverting the deploy, so they never trigger a rollback (alert only).
 *   2. **Deploy-correlation gate** (optional) — when `deployCorrelationWindowMs > 0` and the current
 *      revision's deploy time is known, the failure must have begun within that window after the deploy
 *      to count as update-related. A revision that served healthily for far longer and only now fails is
 *      unlikely to be broken *by the update*. When the deploy time is unknown, this gate is skipped and
 *      the error-class gate alone decides.
 */
export function decideRollback(input: RollbackDecisionInput): RollbackDecision {
  const { failureClass, policy, currentRevisionDeployedAt, detectedAt } = input;
  const allowed = policy.rollbackOn && policy.rollbackOn.length > 0 ? policy.rollbackOn : DEFAULT_ROLLBACK_ON;

  if (!allowed.includes(failureClass)) {
    return {
      rollback: false,
      updateRelated: false,
      failureClass,
      reason: `failure class '${failureClass}' is not update-related (not in rollbackOn=[${allowed.join(
        ', '
      )}]) — a rollback would not fix it; alert only`,
    };
  }

  const windowMs = Math.max(0, Math.floor(policy.deployCorrelationWindowMs || 0));
  if (windowMs > 0 && currentRevisionDeployedAt) {
    const deployed = Date.parse(currentRevisionDeployedAt);
    const detected = Date.parse(detectedAt);
    if (Number.isFinite(deployed) && Number.isFinite(detected)) {
      const ageMs = detected - deployed;
      if (ageMs > windowMs) {
        return {
          rollback: false,
          updateRelated: false,
          failureClass,
          reason: `failure began ${ageMs}ms after the current revision was deployed, beyond the correlation window ${windowMs}ms — the running revision had been healthy well past its deploy, so this is likely NOT caused by the update; alert only`,
        };
      }
      return {
        rollback: true,
        updateRelated: true,
        failureClass,
        reason: `update-related '${failureClass}' failure within ${ageMs}ms of deploy (window ${windowMs}ms) — rollback to the previous revision`,
      };
    }
  }

  return {
    rollback: true,
    updateRelated: true,
    failureClass,
    reason: `update-related failure class '${failureClass}' — rollback eligible${
      windowMs > 0 ? ' (deploy time unknown; correlation gate skipped)' : ''
    }`,
  };
}

export interface RemediationOutcome {
  attempted: boolean;
  /** whether auto-remediation was authorized (INCIDENT_AUTO_REMEDIATE); false ⇒ dry-run only. */
  enabled: boolean;
  command: string | null;
  exitCode: number | null;
  /** the rollback decision (why remediation ran or was skipped). Absent on older records. */
  decision?: RollbackDecision;
}

export interface RecoveryOutcome {
  attempted: boolean;
  state: HealthState | null;
  probe: ProbeResult | null;
}

export interface IncidentRecord {
  target: string;
  detectedAt: string; // ISO 8601, supplied by the caller (keeps rendering deterministic)
  state: HealthState;
  probe: ProbeResult;
  thresholds: ProbeThresholds;
  consecutiveFailures: number;
  remediation?: RemediationOutcome;
  recovery?: RecoveryOutcome;
}

/**
 * Resolve the Cloud Run rollback target: the newest READY revision that is NOT the one currently
 * serving traffic. Cloud Run has no `PREVIOUS` traffic keyword — a real "roll back to the previous
 * revision" must name an actual revision, so we pick it from `gcloud run revisions list` output
 * (newest-first) minus the current serving revision.
 *
 * @param revisions  revision names, newest-first (as `gcloud run revisions list --sort-by=~creationTimestamp`).
 * @param current    the revision currently serving 100% traffic (from the service's traffic split); may be null.
 * @returns the rollback target revision name, or null if there is no distinct prior revision.
 */
export function resolvePreviousRevision(revisions: string[], current: string | null | undefined): string | null {
  const list = (revisions || []).map((r) => (r || '').trim()).filter(Boolean);
  if (list.length === 0) return null;
  const cur = (current || '').trim();
  if (!cur) {
    // Current unknown: assume the newest is serving and roll back to the next one.
    return list[1] ?? null;
  }
  const prior = list.find((r) => r !== cur);
  return prior ?? null;
}

function stateEmoji(state: HealthState | null | undefined): string {
  switch (state) {
    case 'healthy':
      return '🟢';
    case 'degraded':
      return '🟡';
    case 'unhealthy':
      return '🔴';
    default:
      return '⚪';
  }
}

/**
 * Render a deterministic postmortem markdown document from an incident record. Mirrors the six steps
 * the human asked about: 障害検知 → 原因特定 → 処置 → 回復確認 → ポストモーテム (this doc) → デグレ/ロールバック.
 */
export function renderPostmortem(rec: IncidentRecord): string {
  const rem = rec.remediation;
  const recov = rec.recovery;
  const recovered = recov?.state === 'healthy';

  const decision = rem?.decision;
  const decisionLine = decision
    ? `- **Rollback decision:** ${decision.rollback ? '✅ rollback' : '⛔ no rollback'} — ${
        decision.updateRelated ? 'update-related' : 'NOT update-related'
      } (failure class \`${decision.failureClass}\`): ${decision.reason}`
    : null;

  const remediationLine =
    decision && !decision.rollback
      ? `skipped — error not update-related, so no rollback (\`${rem?.command ?? 'n/a'}\`)`
      : !rem?.command
        ? '_(no rollback command configured — none attempted)_'
        : !rem.enabled
          ? `dry-run only (auto-remediation disabled) — would run: \`${rem.command}\``
          : rem.attempted
            ? `executed \`${rem.command}\` → exit \`${rem.exitCode ?? 'n/a'}\``
            : `configured (\`${rem.command}\`) but not attempted`;

  const recoveryLine = !recov?.attempted
    ? '_(remediation not attempted — recovery not re-probed)_'
    : `${stateEmoji(recov.state)} ${recov.state ?? 'unknown'}${recovered ? ' (recovered)' : ' (NOT recovered — escalate)'}`;

  const lines: string[] = [
    `# Postmortem — ${rec.target}`,
    '',
    `> Auto-generated by the production incident auto-response loop (SOT-1520). Best-effort.`,
    '',
    '## Incident',
    '',
    `- **Target:** ${rec.target}`,
    `- **Detected at:** ${rec.detectedAt}`,
    `- **State at detection:** ${stateEmoji(rec.state)} ${rec.state}`,
    `- **Consecutive unhealthy probes:** ${rec.consecutiveFailures} (threshold reached)`,
    '',
    '## ① 障害検知 (Detection)',
    '',
    `- HTTP status: \`${rec.probe.httpStatus ?? 'n/a'}\` (expected \`${rec.thresholds.expectStatus || 200}\`)`,
    `- Latency: \`${rec.probe.latencyMs ?? 'n/a'}\` ms${rec.thresholds.maxLatencyMs ? ` (degraded threshold \`${rec.thresholds.maxLatencyMs}\` ms)` : ''}`,
    `- Probe error: ${rec.probe.error ? `\`${rec.probe.error}\`` : '_none_'}`,
    '',
    '## ② 原因特定 (Root cause)',
    '',
    `- Signal: health endpoint returned ${rec.probe.ok ? 'an unexpected status' : 'no acceptable response'} on ${rec.consecutiveFailures} consecutive probes.`,
    `- Root cause requires human confirmation; this record captures the observable signal only.`,
    '',
    '## ③ 処置 (Remediation / rollback / degradation)',
    '',
    ...(decisionLine ? [decisionLine] : []),
    `- ${remediationLine}`,
    '',
    '## ④ 回復確認 (Recovery verification)',
    '',
    `- ${recoveryLine}`,
    '',
    '## ⑤ Follow-up',
    '',
    `- [ ] Confirm root cause`,
    `- [ ] Add regression test / guard`,
    recovered ? `- [x] Service recovered` : `- [ ] Restore service (auto-recovery did not confirm healthy)`,
    '',
  ];
  return lines.join('\n');
}
