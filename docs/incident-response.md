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
