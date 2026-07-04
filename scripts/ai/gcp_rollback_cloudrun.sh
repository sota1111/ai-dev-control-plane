#!/usr/bin/env bash
# SOT-1520 — Cloud Run rollback helper: shift 100% traffic back to the previous READY revision.
#
# This is the real remediation command referenced by config/incident_response.json[<target>].rollbackCmd.
# Cloud Run has NO `--to-revisions=PREVIOUS=100` keyword — a rollback must name an actual revision — so
# this script resolves the newest READY revision that is NOT the one currently serving traffic and shifts
# 100% of traffic to it (`gcloud run services update-traffic`).
#
# SAFETY: DRY-RUN by default. It only mutates production traffic when called with `--execute`. Without it,
# the resolved rollback command is printed but not run. Best-effort: exit 0 on skip / probe issues so it
# never breaks the incident loop; exit 2 only on bad usage.
#
# Usage:
#   scripts/ai/gcp_rollback_cloudrun.sh --service <name> [--region <r>] [--project <p>] [--to <revision>] [--execute]
# Env fallbacks: INCIDENT_GCP_SERVICE, INCIDENT_GCP_REGION (default asia-northeast1), INCIDENT_GCP_PROJECT.
set -uo pipefail

CONTROL_PLANE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SERVICE="${INCIDENT_GCP_SERVICE:-}"
REGION="${INCIDENT_GCP_REGION:-asia-northeast1}"
PROJECT="${INCIDENT_GCP_PROJECT:-}"
TO_REVISION=""
EXECUTE=false

while [ $# -gt 0 ]; do
  case "$1" in
    --service) SERVICE="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --to) TO_REVISION="${2:-}"; shift 2 ;;
    --execute) EXECUTE=true; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$SERVICE" ]; then
  echo "usage: gcp_rollback_cloudrun.sh --service <name> [--region <r>] [--project <p>] [--to <rev>] [--execute]" >&2
  exit 2
fi

PROJ_ARGS=()
[ -n "$PROJECT" ] && PROJ_ARGS=(--project "$PROJECT")

# Resolve the rollback target unless the caller pinned one with --to.
if [ -z "$TO_REVISION" ]; then
  CURRENT="$(gcloud run services describe "$SERVICE" --region "$REGION" "${PROJ_ARGS[@]}" \
    --format='value(status.traffic[].revisionName)' 2>/dev/null | tr ' ' '\n' | grep -v '^$' | head -1)"
  REVISIONS="$(gcloud run revisions list --service "$SERVICE" --region "$REGION" "${PROJ_ARGS[@]}" \
    --format='value(metadata.name)' --sort-by='~metadata.creationTimestamp' 2>/dev/null)"
  if [ -z "$REVISIONS" ]; then
    echo "[ROLLBACK] could not list revisions for $SERVICE ($REGION) — skipping (best-effort)"
    exit 0
  fi
  # Delegate target selection to the unit-tested pure helper (resolvePreviousRevision).
  TSX_BIN="$CONTROL_PLANE_DIR/node_modules/.bin/tsx"
  RESOLVER='import("'"$CONTROL_PLANE_DIR"'/src/lib/incidentResponse.ts").then(m=>{const revs=process.env.REVS.split("\n").filter(Boolean);const t=m.resolvePreviousRevision(revs,process.env.CUR||null);process.stdout.write(t||"");});'
  if [ -x "$TSX_BIN" ]; then
    TO_REVISION="$(REVS="$REVISIONS" CUR="$CURRENT" "$TSX_BIN" -e "$RESOLVER" 2>/dev/null)"
  else
    # Fallback: newest revision that is not the current serving one.
    TO_REVISION="$(printf '%s\n' "$REVISIONS" | grep -v -x -F "$CURRENT" | head -1)"
  fi
fi

if [ -z "$TO_REVISION" ]; then
  echo "[ROLLBACK] no distinct previous revision to roll back to for $SERVICE — skipping (best-effort)"
  exit 0
fi

CMD=(gcloud run services update-traffic "$SERVICE" --region "$REGION" "${PROJ_ARGS[@]}" \
  --to-revisions "$TO_REVISION=100" --quiet)

if [ "$EXECUTE" = "true" ]; then
  echo "[ROLLBACK] shifting 100% traffic of $SERVICE → $TO_REVISION"
  "${CMD[@]}"
  rc=$?
  echo "[ROLLBACK] update-traffic exit=$rc"
  exit 0
else
  echo "[ROLLBACK] DRY-RUN (pass --execute to roll back). Would run:"
  printf '  %q ' "${CMD[@]}"; echo
  exit 0
fi
