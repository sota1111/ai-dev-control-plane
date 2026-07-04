#!/usr/bin/env bash
# SOT-1520 — provision SERVICE-SIDE (GCP-native) monitoring for a deployed service.
#
# Answers the question "does the monitoring have to run from a local cron, or can it run from the
# service side?": NO local host is required. This script provisions a **Cloud Monitoring uptime check**
# that probes the health endpoint from Google's own global infrastructure (not your laptop / cron), plus
# (optionally) an **alert policy** that fires when the uptime check fails. That is the fully server-side
# equivalent of the local `incident_response.sh` detection step.
#
# Rollback still happens via `scripts/ai/gcp_rollback_cloudrun.sh` (Cloud Run traffic shift); to run the
# whole detect→rollback loop server-side, wire the uptime-check alert to a Cloud Function / Cloud Run job
# (or Cloud Scheduler) that calls the rollback helper — see docs/incident-response.md.
#
# SAFETY: DRY-RUN by default — prints the exact gcloud commands and creates NOTHING. Pass `--execute` to
# actually provision. An uptime check is non-destructive and removable (the script prints the delete
# command). Best-effort: never exits non-zero except on bad usage (2).
#
# Usage:
#   scripts/ai/incident_response_gcp_setup.sh \
#     --host <hostname> [--path /health] [--display <name>] [--project <p>] \
#     [--expect-status 200] [--period 5] [--timeout 10] \
#   --period is MINUTES between checks: one of 1, 5, 10, 15 (Cloud Monitoring uptime-check choices).
#     [--alert] [--notification-channel <channel-id>] [--execute]
set -uo pipefail

HOST=""
PATH_="/health"
DISPLAY=""
PROJECT="${INCIDENT_GCP_PROJECT:-}"
EXPECT_STATUS="200"
PERIOD="5"         # MINUTES between checks — Cloud Monitoring choices: 1, 5, 10, 15
TIMEOUT="10"
MAKE_ALERT=false
CHANNEL=""
EXECUTE=false

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --path) PATH_="${2:-}"; shift 2 ;;
    --display) DISPLAY="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --expect-status) EXPECT_STATUS="${2:-}"; shift 2 ;;
    --period) PERIOD="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT="${2:-}"; shift 2 ;;
    --alert) MAKE_ALERT=true; shift ;;
    --notification-channel) CHANNEL="${2:-}"; shift 2 ;;
    --execute) EXECUTE=true; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$HOST" ]; then
  echo "usage: incident_response_gcp_setup.sh --host <hostname> [--path /health] [--project <p>] [--alert --notification-channel <id>] [--execute]" >&2
  exit 2
fi

[ -z "$DISPLAY" ] && DISPLAY="incident-uptime-${HOST%%.*}"
PROJ_ARGS=()
[ -n "$PROJECT" ] && PROJ_ARGS=(--project "$PROJECT")

run_or_print() { # <label> <cmd...>
  local label="$1"; shift
  if [ "$EXECUTE" = "true" ]; then
    echo "[GCP-SETUP] $label"
    "$@"
    echo "[GCP-SETUP] $label exit=$?"
  else
    echo "[GCP-SETUP] DRY-RUN $label — would run:"
    printf '  %q ' "$@"; echo
  fi
}

echo "[GCP-SETUP] uptime check: https://${HOST}${PATH_} every ${PERIOD}min, expect ${EXPECT_STATUS}, project=${PROJECT:-<default>}"

# Cloud Monitoring uptime check — probed from Google infra, no local host needed.
run_or_print "create uptime check '$DISPLAY'" \
  gcloud monitoring uptime create "$DISPLAY" \
    --resource-type=uptime-url \
    --resource-labels="host=${HOST},project_id=${PROJECT:-}" \
    --path="$PATH_" \
    --port=443 \
    --protocol=https \
    --period="$PERIOD" \
    --timeout="$TIMEOUT" \
    --status-classes="2xx" \
    "${PROJ_ARGS[@]}"

if [ "$MAKE_ALERT" = "true" ]; then
  if [ -z "$CHANNEL" ]; then
    echo "[GCP-SETUP] --alert requires --notification-channel <id>; list with:"
    echo "  gcloud beta monitoring channels list ${PROJECT:+--project $PROJECT}"
  else
    echo "[GCP-SETUP] alert policy: page when uptime check '$DISPLAY' fails → channel $CHANNEL"
    echo "  (create via: gcloud alpha monitoring policies create --notification-channels=$CHANNEL ... )"
    echo "  See docs/incident-response.md for the full policy JSON."
  fi
fi

echo "[GCP-SETUP] to remove later: gcloud monitoring uptime delete <CHECK_ID> ${PROJECT:+--project $PROJECT}"
exit 0
