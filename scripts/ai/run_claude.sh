#!/usr/bin/env bash
set -euo pipefail

# SOT-1459: Claude as a first-class DISPATCHED worker (not only the orchestrator).
# scripts/ai/run_worker.sh invokes this when a role's priority chain selects `claude`. It runs a
# headless `claude -p` for the role's prompt and writes a worker report, mirroring run_codex.sh /
# run_antigravity.sh so the dispatcher can treat all three workers uniformly (exit 75 = non-response
# → hand off to the next worker in the chain).
#
# Same-AI cache reuse: consecutive claude-worker invocations in one run share ONE claude session
# (`--session-id` on first use, `--resume` afterwards), keeping the conversation/prompt cache warm.

CONTROL_PLANE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$CONTROL_PLANE_DIR/docs/ai" "$CONTROL_PLANE_DIR/docs/ai/auto_logs"

# Lane support (mirror run_codex.sh): non-default lanes get `.<lane>` inserted before the extension.
RUNNER_LANE="$(printf '%s' "${RUNNER_LANE:-default}" | tr -cd 'a-zA-Z0-9_-')"
[ -z "$RUNNER_LANE" ] && RUNNER_LANE="default"
LONG_RUN_LANE="$(printf '%s' "${LONG_RUN_LANE:-long-run}" | tr -cd 'a-zA-Z0-9_-')"
[ -z "$LONG_RUN_LANE" ] && LONG_RUN_LANE="long-run"

lane_path() {
  local p="$1"
  if [ "$RUNNER_LANE" = "default" ]; then
    printf '%s' "$p"
    return
  fi
  local dir base name ext
  dir="$(dirname "$p")"
  base="$(basename "$p")"
  ext="${base##*.}"
  name="${base%.*}"
  printf '%s/%s.%s.%s' "$dir" "$name" "$RUNNER_LANE" "$ext"
}

_TSX_BIN="$CONTROL_PLANE_DIR/node_modules/.bin/tsx"
run_cli() {
  if [ -x "$_TSX_BIN" ]; then
    (cd "$CONTROL_PLANE_DIR" && "$_TSX_BIN" src/runner-cli.ts "$@")
  else
    (cd "$CONTROL_PLANE_DIR" && npx tsx src/runner-cli.ts "$@")
  fi
}

PROMPT_FILE="$(lane_path "$CONTROL_PLANE_DIR/prompts/claude/worker.md")"
REPORT_FILE="$(lane_path "$CONTROL_PLANE_DIR/docs/ai/55_worker_claude_report.md")"
# Cooldown/session are per-lane-worker but account-global for usage limits (NOT lane-suffixed cooldown).
CLAUDE_COOLDOWN_FILE="$CONTROL_PLANE_DIR/docs/ai/auto_logs/claude.cooldown.json"
SESSION_ID_FILE="$(lane_path "$CONTROL_PLANE_DIR/docs/ai/auto_logs/claude_worker_session.id")"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

echo "== Claude CLI: dispatched worker =="

# Per-lane WORKER_TIMEOUT (same policy as run_codex.sh).
DEFAULT_WORKER_TIMEOUT=1800
LONG_RUN_WORKER_TIMEOUT="${WORKER_TIMEOUT_LONG_RUN:-21600}"
LANE_ENV_KEY="WORKER_TIMEOUT_$(printf '%s' "$RUNNER_LANE" | tr 'a-z-' 'A-Z_')"
LANE_TIMEOUT_OVERRIDE="${!LANE_ENV_KEY:-}"
if [ -n "$LANE_TIMEOUT_OVERRIDE" ]; then
  WORKER_TIMEOUT="$LANE_TIMEOUT_OVERRIDE"
elif [ -n "${WORKER_TIMEOUT:-}" ]; then
  WORKER_TIMEOUT="$WORKER_TIMEOUT"
elif [ "$RUNNER_LANE" = "$LONG_RUN_LANE" ]; then
  WORKER_TIMEOUT="$LONG_RUN_WORKER_TIMEOUT"
else
  WORKER_TIMEOUT="$DEFAULT_WORKER_TIMEOUT"
fi
WORKER_NONRESPONSE_EXIT=75

# --- Per-role gate (only for DIRECT invocation) ---
# The dispatcher (run_worker.sh) sets RUN_WORKER_DISPATCH=1 and owns chain selection, so we skip the
# gate under dispatch. For a direct/legacy call with WORKER_ROLE set, exit 75 if `claude` is not in
# the role's chain (fail-open on unset/unknown/broken config).
if [ "${RUN_WORKER_DISPATCH:-}" != "1" ] && [ -n "${WORKER_ROLE:-}" ]; then
  WORKER_ROLES_FILE="${WORKER_ROLES_FILE:-$CONTROL_PLANE_DIR/config/worker_roles.json}"
  ROLE_CHAIN="$(node -e '
    const fs = require("fs");
    const [file, role] = process.argv.slice(1);
    const ROLES = ["task-check","decomposition","implementation","verification","acceptance","github","linear-report"];
    const WORKERS = ["claude","codex","antigravity"];
    if (!ROLES.includes(role)) { process.stdout.write(""); process.exit(0); }
    try {
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      const raw = Array.isArray(cfg[role]) ? cfg[role] : [cfg[role]];
      process.stdout.write(raw.filter(w => WORKERS.includes(w)).join(" "));
    } catch (e) { process.stdout.write(""); }
  ' "$WORKER_ROLES_FILE" "$WORKER_ROLE" 2>/dev/null || echo '')"
  if [ -n "$ROLE_CHAIN" ] && [[ " $ROLE_CHAIN " != *" claude "* ]]; then
    echo "WORKER_ROLE=$WORKER_ROLE chain '[$ROLE_CHAIN]' does not include claude, delegating" >&2
    exit "$WORKER_NONRESPONSE_EXIT"
  fi
fi

# --- Claude disable flag (symmetric to CODEX_DISABLED / ANTIGRAVITY_DISABLED) ---
case "$(printf '%s' "${CLAUDE_DISABLED:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on)
    echo "CLAUDE_DISABLED: Claude worker disabled by env flag, delegating" >&2
    exit "$WORKER_NONRESPONSE_EXIT"
    ;;
esac

# --- Claude usage-limit cooldown pre-check (auto fallback / auto resume) ---
if [ -f "$CLAUDE_COOLDOWN_FILE" ]; then
  NOW_EPOCH="$(date +%s)"
  RESUME_AT="$(node -e "try{const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(Number(d.resumeAtEpoch)||0));}catch(e){process.stdout.write('0');}" "$CLAUDE_COOLDOWN_FILE" 2>/dev/null || echo 0)"
  MAX_COOLDOWN_SECONDS="${MAX_COOLDOWN_SECONDS:-18000}"
  if [ "$RESUME_AT" -gt 0 ] && [ "$((RESUME_AT - NOW_EPOCH))" -gt "$MAX_COOLDOWN_SECONDS" ]; then
    echo "CLAUDE_COOLDOWN_CAPPED: resumeAt $RESUME_AT is >${MAX_COOLDOWN_SECONDS}s out (now $NOW_EPOCH), clearing stale cooldown" >&2
    rm -f "$CLAUDE_COOLDOWN_FILE"
  elif [ "$RESUME_AT" -gt 0 ] && [ "$NOW_EPOCH" -lt "$RESUME_AT" ]; then
    echo "CLAUDE_COOLDOWN_ACTIVE: claude usage limit until epoch $RESUME_AT (now $NOW_EPOCH), delegating" >&2
    exit "$WORKER_NONRESPONSE_EXIT"
  else
    echo "Claude cooldown expired (now $NOW_EPOCH >= resumeAt $RESUME_AT), clearing and resuming" >&2
    rm -f "$CLAUDE_COOLDOWN_FILE"
  fi
fi

# --- Build the effective prompt (with optional usage-limit handoff context) ---
# On a mid-processing handoff, run_worker.sh points WORKER_HANDOFF_REPORT at the previous worker's
# partial report so this worker continues the work instead of restarting from scratch.
PROMPT_CONTENT="$(cat "$PROMPT_FILE")"

# Constrain the dispatched worker (SOT-1459). This Claude runs in the repo root and auto-loads
# CLAUDE.md — the ORCHESTRATOR spec (select issues, decompose, run workers, drive the pipeline). A
# dispatched worker must NOT act on those orchestrator instructions, or it would spawn concurrent work
# and process other issues. Pin it to exactly one role for one issue and forbid launching runs.
PROMPT_CONTENT="# YOU ARE A CONSTRAINED WORKER — NOT THE ORCHESTRATOR

You were dispatched by scripts/ai/run_worker.sh to perform EXACTLY ONE role for the single target issue
described below / in docs/ai/pipeline/context.md. CLAUDE.md in this repo describes the ORCHESTRATOR;
IGNORE its instructions about selecting issues, decomposing, driving the pipeline, or processing any
other issue. Hard rules:
- Do ONLY the one role task in this prompt, for ONLY the one target issue. Then write your report and stop.
- Do NOT run scripts/ai/run_auto.sh, scripts/ai/run_worker.sh, scripts/ai/scheduler.sh, the webhook
  server, or the runner queue/drain. Do NOT spawn or trigger any other run. Do NOT process other issues.
- Do NOT run anything in the background or start long-lived processes.

---

$PROMPT_CONTENT"
if [ -n "${WORKER_HANDOFF_REPORT:-}" ] && [ -s "${WORKER_HANDOFF_REPORT:-/nonexistent}" ]; then
  PROMPT_CONTENT="## Handoff from previous worker (${WORKER_HANDOFF_FROM:-unknown})

The previous worker could not finish (non-response / usage limit). Continue its work — do NOT restart
from scratch. Its partial report follows; pick up where it left off and produce the final report.

<<<PREVIOUS_WORKER_REPORT
$(cat "$WORKER_HANDOFF_REPORT")
PREVIOUS_WORKER_REPORT

---

$PROMPT_CONTENT"
fi

# --- Session reuse for a warm prompt cache ---
# First claude-worker invocation of a run creates a session id; later ones resume it. An explicit
# CLAUDE_WORKER_SESSION_ID (e.g. shared by the orchestrator) overrides the per-lane file.
if [ -n "${CLAUDE_WORKER_SESSION_ID:-}" ]; then
  SID="$CLAUDE_WORKER_SESSION_ID"
  SESSION_ARGS=(--resume "$SID")
elif [ -s "$SESSION_ID_FILE" ]; then
  SID="$(cat "$SESSION_ID_FILE")"
  SESSION_ARGS=(--resume "$SID")
else
  SID="$( (command -v uuidgen >/dev/null 2>&1 && uuidgen) || cat /proc/sys/kernel/random/uuid )"
  printf '%s' "$SID" > "$SESSION_ID_FILE"
  SESSION_ARGS=(--session-id "$SID")
fi

# SOT-1583: a per-issue directive `workers: <role>=claude:<model>` sets CLAUDE_MODEL (via
# run_worker.sh); it is consumed here as `--model`. Unset → default `opus` (backward compatible).
CLAUDE_MODEL="${CLAUDE_MODEL:-opus}"
export CLAUDE_MODEL

ADD_DIR_ARGS=()
if [ -n "${TARGET_REPO:-}" ]; then
  echo "Target repository: $TARGET_REPO"
  ADD_DIR_ARGS=(--add-dir "$TARGET_REPO")
fi

set +e
timeout "${WORKER_TIMEOUT}s" claude \
  --model "$CLAUDE_MODEL" \
  --dangerously-skip-permissions \
  "${SESSION_ARGS[@]}" \
  "${ADD_DIR_ARGS[@]}" \
  -p "$PROMPT_CONTENT" 2>&1 | tee "$REPORT_FILE"
EXIT_CODE="${PIPESTATUS[0]}"
set -e

# --- Claude usage-limit detection (set cooldown, delegate) ---
if [ "$EXIT_CODE" -ne 0 ] \
  && [ -f "$REPORT_FILE" ] \
  && grep -Ei "usage limit|rate limit|try again at|resets at|429|too many requests" "$REPORT_FILE" > /dev/null; then
  mkdir -p "$(dirname "$CLAUDE_COOLDOWN_FILE")"
  RESUME_EPOCH="$( run_cli parse-usage-limit-epoch < "$REPORT_FILE" 2>/dev/null || true)"
  if [ -n "$RESUME_EPOCH" ]; then
    node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({resumeAtEpoch:Number(process.argv[2]),detectedAt:new Date().toISOString(),reason:'claude_usage_limit'},null,2));" "$CLAUDE_COOLDOWN_FILE" "$RESUME_EPOCH"
    echo "CLAUDE_USAGE_LIMIT: cooldown set until epoch $RESUME_EPOCH, delegating" >&2
    run_cli notify-cooldown claude >/dev/null 2>&1 || true
  else
    echo "CLAUDE_USAGE_LIMIT: detected but reset time unparseable, notifying without cooldown" >&2
    run_cli notify-usage-limit-unknown claude >/dev/null 2>&1 || true
  fi
  exit "$WORKER_NONRESPONSE_EXIT"
fi

# Validation logic (same contract as run_codex.sh / run_antigravity.sh).
REASON=""
if [ "$EXIT_CODE" -eq 124 ]; then
  REASON="timeout"
elif [ "$EXIT_CODE" -ne 0 ]; then
  REASON="crash (exit $EXIT_CODE)"
elif [ ! -f "$REPORT_FILE" ]; then
  REASON="missing report"
elif [ ! -s "$REPORT_FILE" ] || [ -z "$(grep '[^[:space:]]' "$REPORT_FILE")" ]; then
  REASON="empty report"
elif ! grep -q "## Next Action" "$REPORT_FILE"; then
  REASON="invalid report (missing ## Next Action)"
fi

if [ -n "$REASON" ]; then
  echo "WORKER_NONRESPONSE: claude ($REASON)" >&2
  exit "$WORKER_NONRESPONSE_EXIT"
fi

# Post the worker report to Discord (best-effort; never affects worker success).
run_cli notify-worker-report claude "$REPORT_FILE" >/dev/null 2>&1 || true
