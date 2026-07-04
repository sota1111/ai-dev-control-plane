# Production Incident Auto-Response (SOT-1520)

The harness can run an automatic incident-response loop against a **deployed** service:

```
① 障害検知      detect     — probe the health endpoint N times → healthy / degraded / unhealthy
② 原因特定      identify   — capture status / latency / error of the failing probes
③ 処置          remediate  — run the configured rollback / degrade command
④ 回復確認      verify     — re-probe and confirm the service is healthy again
⑤ ポストモーテム postmortem — auto-generate docs/ai/incidents/<target>-<ts>.md
```

This complements the existing **dev/CI worker** self-healing loop (Worker Non-Response Fallback Policy +
Worker Failure Re-Delegation Rules). That loop handles failures *while building* an Issue; this loop
handles failures of an *already-deployed* service.

## Components

| File | Role |
| --- | --- |
| `scripts/ai/incident_response.sh` | Orchestrator (detect → remediate → verify → postmortem). Best-effort, OFF by default. |
| `src/lib/incidentResponse.ts` | Pure logic: `classifyProbe`, `shouldTriggerIncident`, `renderPostmortem`. Unit-tested. |
| `src/incident-postmortem-cli.ts` | Reads an incident record (stdin JSON) → postmortem markdown (stdout). |
| `config/incident_response.json` | Per-target config: health URL, expected status, latency threshold, rollback command. Empty by default. |
| `docs/ai/incidents/` | Auto-generated postmortems land here. |

## Safety model (default OFF)

Real monitoring and rollback need deploy-environment credentials + a live service URL that do **not**
live in this repo — so, mirroring `scripts/ai/redeploy_after_merge.sh`, the loop is off by default and
gated by **two** switches:

- `INCIDENT_RESPONSE_ENABLED` (default OFF) — the whole loop is skipped unless this is truthy.
- `INCIDENT_AUTO_REMEDIATE` (default OFF) — even when the loop runs and confirms an incident, the
  rollback command is only **dry-run logged** (`would run: …`) unless this is *also* truthy. Enabling
  monitoring never by itself authorizes an automatic production rollback.

Exit code is always `0` except on bad usage (`2`): a skipped run, a failed probe, and a failed rollback
are all best-effort and never break the caller (e.g. a cron entry).

## Configuration

Add an entry per monitored service to `config/incident_response.json`, keyed by repo slug
(`owner/name`) or project name:

```json
{
  "sota1111/toddler-private-rag": {
    "healthUrl": "https://toddler-private-rag.example.run.app/healthz",
    "expectStatus": 200,
    "maxLatencyMs": 3000,
    "rollbackCmd": "gcloud run services update-traffic toddler-private-rag --to-revisions=PREVIOUS=100 --region us-central1 --quiet",
    "localPath": "/workspaces/toddler-private-rag"
  }
}
```

Any field can be overridden by env (`INCIDENT_HEALTH_URL`, `INCIDENT_EXPECT_STATUS`,
`INCIDENT_MAX_LATENCY_MS`, `INCIDENT_ROLLBACK_CMD`). Tuning: `INCIDENT_FAILURE_THRESHOLD` (default 3),
`INCIDENT_PROBE_ATTEMPTS`, `INCIDENT_PROBE_INTERVAL`, `INCIDENT_PROBE_TIMEOUT`, `INCIDENT_DIR`.

## Usage

```bash
# One-shot check of a target (run from a credentialed environment):
INCIDENT_RESPONSE_ENABLED=1 INCIDENT_AUTO_REMEDIATE=1 \
  scripts/ai/incident_response.sh sota1111/toddler-private-rag /workspaces/toddler-private-rag
```

To monitor continuously, schedule it (e.g. a cron entry every few minutes) in the deploy environment.
The loop is idempotent per run: it probes, and only on a confirmed incident does it remediate and write
a postmortem.

## Service-side (GCP-native) monitoring — no local host required

> **Q: Does the cron have to run locally? Can the monitoring run from the service side instead?**
> **A: No, it does not need a local host — and yes, monitoring can run entirely server-side on GCP.**

`incident_response.sh` is convenient (one script does detect→rollback→postmortem) but requires *some*
always-on credentialed host to run the cron. The more robust option for a Cloud Run deployment is to let
**Google's own infrastructure** do the probing:

| Concern | Local cron (`incident_response.sh`) | Service-side (GCP-native) |
| --- | --- | --- |
| Where the probe runs | your host / cron | Google global probers (**no host needed**) |
| Detection | curl loop in the script | **Cloud Monitoring uptime check** |
| Alerting | log line / exit code | **Alert policy → notification channel** |
| Rollback | `gcloud run services update-traffic` | same, triggered by Cloud Function / Cloud Run job / Cloud Scheduler |

### 1. Provision the uptime check (detection, server-side)

`scripts/ai/incident_response_gcp_setup.sh` creates a Cloud Monitoring **uptime check** that probes the
health URL from Google infra every N minutes (`--period` one of 1/5/10/15, default 5). DRY-RUN by
default; pass `--execute` to provision.

```bash
# Dry-run (prints the exact gcloud command, creates nothing):
scripts/ai/incident_response_gcp_setup.sh \
  --host toddler-private-rag-backend-iqrm6wvhfq-an.a.run.app --path /health \
  --project gen-lang-client-0243034020

# Actually provision (uptime check is non-destructive and removable):
scripts/ai/incident_response_gcp_setup.sh \
  --host toddler-private-rag-backend-iqrm6wvhfq-an.a.run.app --path /health \
  --project gen-lang-client-0243034020 --execute
```

Add `--alert --notification-channel <id>` (list channels with
`gcloud beta monitoring channels list`) to also wire an alert policy so a failing uptime check pages you.

### 2. Rollback (remediation)

Cloud Run has **no `--to-revisions=PREVIOUS=100` keyword** — a rollback must name a real revision. Use
`scripts/ai/gcp_rollback_cloudrun.sh`, which resolves the newest READY revision that is *not* currently
serving (unit-tested `resolvePreviousRevision`) and shifts 100% traffic to it. DRY-RUN by default:

```bash
# Show what it would do:
scripts/ai/gcp_rollback_cloudrun.sh --service toddler-private-rag-backend --region asia-northeast1 \
  --project gen-lang-client-0243034020
# Actually roll back:
scripts/ai/gcp_rollback_cloudrun.sh --service toddler-private-rag-backend --region asia-northeast1 \
  --project gen-lang-client-0243034020 --execute
```

This is the command wired into `config/incident_response.json` as the toddler-private-rag `rollbackCmd`.

### 3. Fully server-side loop (optional)

To run detect→rollback with **no host at all**: point the uptime-check alert policy at a notification
channel, and have a **Cloud Function / Cloud Run job** (triggered by the alert, or by Cloud Scheduler on
a schedule) invoke the rollback helper. Cloud Scheduler + a small Cloud Run job that runs
`gcp_rollback_cloudrun.sh --execute` is the minimal serverless equivalent of the local cron.

**Safety unchanged:** provisioning scripts are DRY-RUN by default; automatic traffic rollback only ever
runs when explicitly enabled (`--execute`, or `INCIDENT_AUTO_REMEDIATE=1` for the local loop).
