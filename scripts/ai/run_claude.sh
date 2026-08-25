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

# SOT-1615: surface the model in the banner so run_auto.sh's tag filter can render `[claude-<model>]`
# in the log instead of a bare `[claude]`. Claude always resolves to a concrete model (default `opus`,
# same default applied at invocation below), so the tag always carries it.
echo "== Claude CLI: dispatched worker == model=${CLAUDE_MODEL:-opus}"

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
# Usage limit is distinct from a crash/non-response: the dispatcher must not hand this Claude issue
# to GPT. It bubbles the marker up so the runner can park this issue and continue the GPT queue.
WORKER_USAGE_LIMIT_EXIT=77

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
    exit "$WORKER_USAGE_LIMIT_EXIT"
  else
    echo "Claude cooldown expired (now $NOW_EPOCH >= resumeAt $RESUME_AT), clearing and resuming" >&2
    rm -f "$CLAUDE_COOLDOWN_FILE"
  fi
fi

# --- Build the effective prompt (with optional usage-limit handoff context) ---
# On a mid-processing handoff, run_worker.sh points WORKER_HANDOFF_REPORT at the previous worker's
# partial report so this worker continues the work instead of restarting from scratch.
PROMPT_CONTENT="$(cat "$PROMPT_FILE")"

# Per-issue structured context fetched from Linear GraphQL by run_auto.sh.
CTX_FILE="${PIPELINE_CONTEXT_JSON_FILE:-${PIPELINE_CONTEXT_FILE:-}}"

# Constrain the dispatched worker (SOT-1459). This Claude runs in the repo root and auto-loads
# CLAUDE.md — the ORCHESTRATOR spec (select issues, decompose, run workers, drive the pipeline). A
# dispatched worker must not launch nested pipeline runs. Pin it to exactly one role and forbid
# launching runs; Linear issue selection itself is not restricted here.
# SOT-1591 (solo mode): when dispatched as the synthetic `solo` role, this worker instead owns the
# ENTIRE lifecycle for the single target issue in ONE session — so the "exactly one role" clause is
# replaced by an "all roles, one issue" clause. The nested-run guards are kept either way.
if [ "${WORKER_ROLE:-}" = "solo" ]; then
  PROMPT_CONTENT="# YOU ARE THE SOLO WORKER — ONE AI, THE WHOLE LIFECYCLE FOR ONE ISSUE

You were dispatched by scripts/ai/run_worker.sh in SOLO MODE to run the ENTIRE lifecycle for the single
target issue in $CTX_FILE, yourself, in this one session — with NO per-role script
handoff. Follow CLAUDE.md's role specs, quality gates, GitHub policy, and Linear policy, but you perform
every step directly: task-check (incl. 分解判断) → implementation → verification → acceptance → github
(branch/PR/merge) → linear-report. Hard rules:
- Do NOT run scripts/ai/run_auto.sh, scripts/ai/run_worker.sh, scripts/ai/scheduler.sh, the webhook
  server, or the runner queue/drain. Do NOT spawn or trigger any other run.
- In-container background and long-lived commands are allowed. Track their PID/log/output and wait for
  required results before reporting completion. Do not use ScheduleWakeup or end with waiting prose;
  keep this CLI session alive with repeated bounded polls and always emit the report contract. On a
  retry, inspect existing PIDs/outputs and never launch a duplicate writer for the same result.

---

$PROMPT_CONTENT"
else
  PROMPT_CONTENT="# YOU ARE A CONSTRAINED WORKER — NOT THE ORCHESTRATOR

You were dispatched by scripts/ai/run_worker.sh to perform EXACTLY ONE role for the single target issue
described below / in $CTX_FILE. CLAUDE.md in this repo describes the ORCHESTRATOR;
IGNORE its instructions about decomposing or driving the pipeline. Hard rules:
- Do ONLY the one role task in this prompt. Then write your report and stop.
- Do NOT run scripts/ai/run_auto.sh, scripts/ai/run_worker.sh, scripts/ai/scheduler.sh, the webhook
  server, or the runner queue/drain. Do NOT spawn or trigger any other run.
- Do NOT run anything in the background or start long-lived processes.

---

$PROMPT_CONTENT"
fi
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
#
# Friendly model aliases for the Claude worker. A Linear directive can select a Claude model by a short
# human name (e.g. `workers: implementation=claude:fable`) instead of the full `--model` id. Resolve the
# alias to the canonical id here; matching is case-insensitive and unknown values pass through verbatim,
# so the built-in shorthands (`opus`/`sonnet`/`haiku`) and raw ids (`claude-opus-4-8`, etc.) still work.
# Add new aliases to this case.
#   fable / fable-5 / fable5  → Fable 5 (canonical id: claude-fable-5)
resolve_claude_model_alias() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    fable|fable-5|fable5) echo "claude-fable-5" ;;
    *) printf '%s' "$1" ;;
  esac
}

CLAUDE_MODEL="$(resolve_claude_model_alias "${CLAUDE_MODEL:-opus}")"
export CLAUDE_MODEL

ADD_DIR_ARGS=()
if [ -n "${TARGET_REPO:-}" ]; then
  echo "Target repository: $TARGET_REPO"
  ADD_DIR_ARGS=(--add-dir "$TARGET_REPO")
fi

set +e
if [ "${WORKER_ROLE:-}" = "solo" ]; then
  # SOT-1591 (solo live output): solo runs the WHOLE lifecycle in ONE `claude -p` session. Default
  # (text) `-p` buffers all output until the end, so the run log/report stay empty for the whole run and
  # a hang (e.g. a stuck test command) is invisible. Stream instead: `--output-format stream-json
  # --verbose` emits events as they happen; solo_stream_format.py prints concise LIVE progress to stdout
  # (→ run log/Discord) AND writes the final report text to REPORT_FILE (kept parseable for the
  # `## Acceptance` / `## Next Action` gate). PIPESTATUS[0] stays claude's own exit code (timeout=124…).
  claude \
    --model "$CLAUDE_MODEL" \
    --dangerously-skip-permissions \
    "${SESSION_ARGS[@]}" \
    "${ADD_DIR_ARGS[@]}" \
    --output-format stream-json --verbose \
    -p "$PROMPT_CONTENT" 2>&1 \
    | python3 -u "$CONTROL_PLANE_DIR/scripts/ai/solo_stream_format.py" "$REPORT_FILE"
  EXIT_CODE="${PIPESTATUS[0]}"
else
  timeout "${WORKER_TIMEOUT}s" claude \
    --model "$CLAUDE_MODEL" \
    --dangerously-skip-permissions \
    "${SESSION_ARGS[@]}" \
    "${ADD_DIR_ARGS[@]}" \
    -p "$PROMPT_CONTENT" 2>&1 | tee "$REPORT_FILE"
  EXIT_CODE="${PIPESTATUS[0]}"
fi
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
  exit "$WORKER_USAGE_LIMIT_EXIT"
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
