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

export interface RemediationOutcome {
  attempted: boolean;
  /** whether auto-remediation was authorized (INCIDENT_AUTO_REMEDIATE); false ⇒ dry-run only. */
  enabled: boolean;
  command: string | null;
  exitCode: number | null;
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

  const remediationLine = !rem?.command
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
