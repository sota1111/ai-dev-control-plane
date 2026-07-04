#!/usr/bin/env bash
# SOT-1520 — best-effort production incident auto-response orchestrator.
#
# Runs the full loop the human asked for against a DEPLOYED service:
#   ① 障害検知     detect   — probe the health endpoint N times, classify healthy/degraded/unhealthy
#   ② 原因特定     identify — capture status / latency / error of the failing probes
#   ③ 処置         remediate— run the configured rollback / degrade command
#   ④ 回復確認     verify   — re-probe and confirm the service is healthy again
#   ⑤ ポストモーテム postmortem — auto-generate docs/ai/incidents/<target>-<ts>.md
#
# SAFETY: OFF by default. This never runs unless INCIDENT_RESPONSE_ENABLED is truthy. Even then, the
# rollback command is DRY-RUN logged unless INCIDENT_AUTO_REMEDIATE is *also* truthy — so enabling
# monitoring does not by itself authorize an automatic production rollback. Real monitoring/rollback
# need deploy-environment credentials + a live URL that do not live in this repo (mirrors the
# redeploy_after_merge.sh / config/deploy_commands.json best-effort, default-OFF convention).
#
# Exit code is ALWAYS 0 except on bad usage (2): skipping, a failed probe, and a failed rollback are
# all best-effort and must never break the caller (e.g. a cron entry).
#
# Usage:
#   scripts/ai/incident_response.sh <target> [localPath]
#     <target>    : repo slug "owner/name" OR project name — key into config/incident_response.json
#     [localPath] : directory to run the rollback command in (optional; overrides config localPath)
#
# Config/env resolution (env override wins over config/incident_response.json[<target>]):
#   healthUrl    : $INCIDENT_HEALTH_URL
#   expectStatus : $INCIDENT_EXPECT_STATUS       (default 200)
#   maxLatencyMs : $INCIDENT_MAX_LATENCY_MS       (default 0 = latency check off)
#   rollbackCmd  : $INCIDENT_ROLLBACK_CMD
#   localPath    : positional arg, else config
# Tuning env:
#   INCIDENT_FAILURE_THRESHOLD (default 3)  consecutive unhealthy probes ⇒ incident
#   INCIDENT_PROBE_ATTEMPTS    (default =threshold)  how many probes to take during detection
#   INCIDENT_PROBE_INTERVAL    (default 0)  seconds to sleep between probes
#   INCIDENT_PROBE_TIMEOUT     (default 10) curl --max-time seconds
#   INCIDENT_DIR               (default docs/ai/incidents) where postmortems are written
#   INCIDENT_PROBE_CMD         test/override hook: prints "<ok> <httpStatus> <latencyMs> [error]"
# Update-related rollback gating (SOT-1520 REOPEN#4) — rollback only for errors a rollback can fix:
#   INCIDENT_ROLLBACK_ON                     comma-separated failure classes eligible for rollback
#                                            (default server-error,unreachable,not-found; excludes 4xx client-error)
#   INCIDENT_DEPLOY_CORRELATION_WINDOW_MS    (default 0 = off) only failures within this many ms of the
#                                            current revision's deploy count as update-related
#   INCIDENT_CURRENT_REVISION_DEPLOYED_AT    ISO deploy time of the current revision (for the window; optional)
set -uo pipefail

CONTROL_PLANE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TARGET="${1:-}"
LOCAL_PATH_ARG="${2:-}"
if [ -z "$TARGET" ]; then
  echo "usage: incident_response.sh <target> [localPath]" >&2
  exit 2
fi

truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1 | true | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

# Master switch — default OFF.
if ! truthy "${INCIDENT_RESPONSE_ENABLED:-}"; then
  echo "[INCIDENT] disabled (INCIDENT_RESPONSE_ENABLED not set) — skipping for $TARGET"
  exit 0
fi

CONFIG="$CONTROL_PLANE_DIR/config/incident_response.json"
read_cfg() { # <field>
  [ -f "$CONFIG" ] || { printf ''; return 0; }
  node -e 'try{const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const k=process.argv[2];const e=(k&&!k.startsWith("__"))?(m[k]||{}):{};const v=e[process.argv[3]];process.stdout.write(v==null?"":String(v));}catch(e){process.stdout.write("");}' "$CONFIG" "$TARGET" "$1" 2>/dev/null || printf ''
}

HEALTH_URL="${INCIDENT_HEALTH_URL:-$(read_cfg healthUrl)}"
EXPECT_STATUS="${INCIDENT_EXPECT_STATUS:-$(read_cfg expectStatus)}"; EXPECT_STATUS="${EXPECT_STATUS:-200}"
MAX_LATENCY_MS="${INCIDENT_MAX_LATENCY_MS:-$(read_cfg maxLatencyMs)}"; MAX_LATENCY_MS="${MAX_LATENCY_MS:-0}"
ROLLBACK_CMD="${INCIDENT_ROLLBACK_CMD:-$(read_cfg rollbackCmd)}"
LOCAL_PATH="${LOCAL_PATH_ARG:-$(read_cfg localPath)}"
# SOT-1520 REOPEN#4 — limit rollback to update-related errors.
ROLLBACK_ON="${INCIDENT_ROLLBACK_ON:-$(read_cfg rollbackOn)}"
CORRELATION_WINDOW_MS="${INCIDENT_DEPLOY_CORRELATION_WINDOW_MS:-$(read_cfg deployCorrelationWindowMs)}"; CORRELATION_WINDOW_MS="${CORRELATION_WINDOW_MS:-0}"
DEPLOYED_AT="${INCIDENT_CURRENT_REVISION_DEPLOYED_AT:-$(read_cfg currentRevisionDeployedAt)}"
THRESHOLD="${INCIDENT_FAILURE_THRESHOLD:-3}"
ATTEMPTS="${INCIDENT_PROBE_ATTEMPTS:-$THRESHOLD}"
INTERVAL="${INCIDENT_PROBE_INTERVAL:-0}"
INCIDENT_DIR="${INCIDENT_DIR:-$CONTROL_PLANE_DIR/docs/ai/incidents}"

if [ -z "$HEALTH_URL" ] && [ -z "${INCIDENT_PROBE_CMD:-}" ]; then
  echo "[INCIDENT] no health URL configured for $TARGET — skipping (best-effort)"
  exit 0
fi

# One probe → prints "<ok> <httpStatus> <latencyMs> [error]" (ok = 1 healthy request / 0 failure).
run_probe() {
  if [ -n "${INCIDENT_PROBE_CMD:-}" ]; then
    bash -c "$INCIDENT_PROBE_CMD"
    return 0
  fi
  local out code status time_total latency
  out="$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time "${INCIDENT_PROBE_TIMEOUT:-10}" "$HEALTH_URL" 2>/dev/null)"
  code=$?
  status="$(printf '%s' "$out" | awk '{print $1}')"; status="${status:-0}"
  time_total="$(printf '%s' "$out" | awk '{print $2}')"; time_total="${time_total:-0}"
  latency="$(awk -v t="$time_total" 'BEGIN{printf "%d", t*1000}')"
  if [ "$code" -ne 0 ]; then
    echo "0 $status $latency curl_exit_$code"
  elif [ "$status" = "$EXPECT_STATUS" ]; then
    echo "1 $status $latency"
  else
    echo "0 $status $latency unexpected_status"
  fi
}

is_num() { case "${1:-}" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac; }

# ── ① Detection: probe ATTEMPTS times, count unhealthy ────────────────────────────────────────────
unhealthy=0; degraded=0; last_status=0; last_latency=0; last_error=""
for _ in $(seq 1 "$ATTEMPTS"); do
  line="$(run_probe)"
  ok="$(printf '%s' "$line" | awk '{print $1}')"
  last_status="$(printf '%s' "$line" | awk '{print $2}')"
  last_latency="$(printf '%s' "$line" | awk '{print $3}')"
  last_error="$(printf '%s' "$line" | cut -d' ' -f4-)"
  if [ "$ok" = "1" ]; then
    if is_num "$MAX_LATENCY_MS" && [ "$MAX_LATENCY_MS" -gt 0 ] && is_num "$last_latency" && [ "$last_latency" -gt "$MAX_LATENCY_MS" ]; then
      degraded=1
    fi
  else
    unhealthy=$((unhealthy + 1))
  fi
  if is_num "$INTERVAL" && [ "$INTERVAL" -gt 0 ]; then sleep "$INTERVAL"; fi
done

if [ "$unhealthy" -lt "$THRESHOLD" ]; then
  if [ "$degraded" = "1" ]; then
    echo "[INCIDENT] $TARGET degraded (latency>${MAX_LATENCY_MS}ms) but below failure threshold ($unhealthy/$THRESHOLD) — monitoring only"
  else
    echo "[INCIDENT] $TARGET healthy ($unhealthy/$THRESHOLD unhealthy probes) — no action"
  fi
  exit 0
fi

echo "[INCIDENT] $TARGET INCIDENT confirmed: $unhealthy/$THRESHOLD probes unhealthy (last status=$last_status)"
DETECTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── ②b Cause classification: is this error update-related (rollback-eligible)? ─────────────────────
# Limit rollback to errors that a rollback can plausibly fix (server-side / unreachable / route-gone),
# and — when a deploy time is known — that correlate with the current deployment. Delegate the decision
# to the same pure logic the unit tests cover (src/lib/incidentResponse.ts) via a tiny tsx CLI.
DECISION_LINE=""
run_decision() {
  HTTP_STATUS="$last_status" EXPECT_STATUS="$EXPECT_STATUS" ROLLBACK_ON="$ROLLBACK_ON" \
  CORRELATION_WINDOW_MS="$CORRELATION_WINDOW_MS" DEPLOYED_AT="$DEPLOYED_AT" DETECTED_AT="$DETECTED_AT" \
  "$@" "$CONTROL_PLANE_DIR/src/incident-rollback-decision-cli.ts" 2>/dev/null
}
TSX_BIN="$CONTROL_PLANE_DIR/node_modules/.bin/tsx"
if [ -x "$TSX_BIN" ]; then
  DECISION_LINE="$(run_decision "$TSX_BIN")"
else
  DECISION_LINE="$(cd "$CONTROL_PLANE_DIR" && HTTP_STATUS="$last_status" EXPECT_STATUS="$EXPECT_STATUS" ROLLBACK_ON="$ROLLBACK_ON" CORRELATION_WINDOW_MS="$CORRELATION_WINDOW_MS" DEPLOYED_AT="$DEPLOYED_AT" DETECTED_AT="$DETECTED_AT" npx tsx src/incident-rollback-decision-cli.ts 2>/dev/null)"
fi
ROLLBACK_ALLOWED="$(printf '%s' "$DECISION_LINE" | sed -n 's/.*ROLLBACK=\([a-z]*\).*/\1/p')"
UPDATE_RELATED="$(printf '%s' "$DECISION_LINE" | sed -n 's/.*UPDATE_RELATED=\([a-z]*\).*/\1/p')"
FAILURE_CLASS="$(printf '%s' "$DECISION_LINE" | sed -n 's/.*CLASS=\([a-z-]*\).*/\1/p')"; FAILURE_CLASS="${FAILURE_CLASS:-unknown}"
DECISION_REASON="$(printf '%s' "$DECISION_LINE" | sed -n 's/.*REASON=//p')"
# Fail-safe: if the decision could not be computed (tsx missing/broke), do NOT roll back automatically.
[ -z "$ROLLBACK_ALLOWED" ] && { ROLLBACK_ALLOWED="false"; UPDATE_RELATED="false"; DECISION_REASON="rollback decision unavailable (tsx failed) — not rolling back automatically"; }
echo "[INCIDENT] cause: class=$FAILURE_CLASS update-related=$UPDATE_RELATED rollback=$ROLLBACK_ALLOWED — $DECISION_REASON"

# ── ③ Remediation: rollback / degrade (dry-run unless INCIDENT_AUTO_REMEDIATE) ────────────────────
# Rollback runs only when the error is update-related (ROLLBACK_ALLOWED=true).
REMEDIATE_ATTEMPTED=false; REMEDIATE_ENABLED=false; REMEDIATE_EXIT=null
if [ "$ROLLBACK_ALLOWED" != "true" ]; then
  echo "[INCIDENT] not rolling back $TARGET — error not update-related ($FAILURE_CLASS): $DECISION_REASON"
elif [ -n "$ROLLBACK_CMD" ]; then
  if truthy "${INCIDENT_AUTO_REMEDIATE:-}"; then
    REMEDIATE_ENABLED=true; REMEDIATE_ATTEMPTED=true
    echo "[INCIDENT] remediating $TARGET: $ROLLBACK_CMD"
    (
      if [ -n "$LOCAL_PATH" ]; then cd "$LOCAL_PATH" || exit 1; fi
      bash -c "$ROLLBACK_CMD"
    )
    REMEDIATE_EXIT=$?
    echo "[INCIDENT] remediation exit=$REMEDIATE_EXIT"
  else
    echo "[INCIDENT] auto-remediation disabled (INCIDENT_AUTO_REMEDIATE not set) — would run: $ROLLBACK_CMD"
  fi
else
  echo "[INCIDENT] no rollback command configured for $TARGET — skipping remediation"
fi

# ── ④ Recovery verification: re-probe once after a real remediation ───────────────────────────────
RECOVERY_STATE="unknown"
if [ "$REMEDIATE_ATTEMPTED" = "true" ]; then
  rec_line="$(run_probe)"
  rec_ok="$(printf '%s' "$rec_line" | awk '{print $1}')"
  if [ "$rec_ok" = "1" ]; then RECOVERY_STATE="healthy"; else RECOVERY_STATE="unhealthy"; fi
  echo "[INCIDENT] recovery probe: $RECOVERY_STATE"
fi

# ── ⑤ Postmortem: build an IncidentRecord and render it via the tsx CLI ───────────────────────────
mkdir -p "$INCIDENT_DIR" 2>/dev/null || true
SANITIZED="$(printf '%s' "$TARGET" | tr '/ :' '___')"
PM_FILE="$INCIDENT_DIR/${SANITIZED}-$(date -u +%Y%m%dT%H%M%SZ).md"

INCIDENT_JSON="$(
  T="$TARGET" DAT="$DETECTED_AT" LS="$last_status" LL="$last_latency" LE="$last_error" \
  ES="$EXPECT_STATUS" ML="$MAX_LATENCY_MS" UH="$unhealthy" \
  RA="$REMEDIATE_ATTEMPTED" RE="$REMEDIATE_ENABLED" RC="$ROLLBACK_CMD" RX="$REMEDIATE_EXIT" RS="$RECOVERY_STATE" \
  DRB="$ROLLBACK_ALLOWED" DUR="$UPDATE_RELATED" DFC="$FAILURE_CLASS" DRE="$DECISION_REASON" \
  node -e '
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const rec = {
      target: process.env.T,
      detectedAt: process.env.DAT,
      state: "unhealthy",
      probe: { ok: false, httpStatus: num(process.env.LS), latencyMs: num(process.env.LL), error: process.env.LE || null },
      thresholds: { expectStatus: num(process.env.ES) || 200, maxLatencyMs: num(process.env.ML) || 0 },
      consecutiveFailures: num(process.env.UH) || 0,
      remediation: {
        attempted: process.env.RA === "true",
        enabled: process.env.RE === "true",
        command: process.env.RC ? process.env.RC : null,
        exitCode: process.env.RX === "null" ? null : num(process.env.RX),
        decision: {
          rollback: process.env.DRB === "true",
          updateRelated: process.env.DUR === "true",
          failureClass: process.env.DFC || "unknown",
          reason: process.env.DRE || "",
        },
      },
      recovery: {
        attempted: process.env.RA === "true",
        state: process.env.RS === "unknown" ? null : process.env.RS,
        probe: null,
      },
    };
    process.stdout.write(JSON.stringify(rec));
  ' 2>/dev/null
)"

TSX_BIN="$CONTROL_PLANE_DIR/node_modules/.bin/tsx"
if [ -x "$TSX_BIN" ]; then
  printf '%s' "$INCIDENT_JSON" | "$TSX_BIN" "$CONTROL_PLANE_DIR/src/incident-postmortem-cli.ts" >"$PM_FILE" 2>/dev/null || true
else
  printf '%s' "$INCIDENT_JSON" | (cd "$CONTROL_PLANE_DIR" && npx tsx src/incident-postmortem-cli.ts) >"$PM_FILE" 2>/dev/null || true
fi

if [ -s "$PM_FILE" ]; then
  echo "[INCIDENT] postmortem written: $PM_FILE"
else
  echo "[INCIDENT] postmortem generation failed (best-effort) for $TARGET" >&2
fi

exit 0
