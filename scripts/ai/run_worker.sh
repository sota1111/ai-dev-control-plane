#!/usr/bin/env bash
set -euo pipefail

# SOT-1459: unified per-role worker dispatcher.
#
# Usage: scripts/ai/run_worker.sh <role> [--dry-run]
#   <role> ∈ task-check | decomposition | implementation | verification | acceptance | github | linear-report
#
# This script — NOT an AI — decides which worker handles a role. It reads the role's ordered priority
# chain from config/worker_roles.json and invokes each worker's run script (run_codex.sh /
# run_claude.sh / run_antigravity.sh) in order. If a worker is non-responsive (exit 75: usage limit,
# crash, timeout, or invalid report) it HANDS OFF to the next worker in the chain, passing the partial
# report so the next worker continues instead of restarting. On the first worker that succeeds
# (exit 0) the dispatcher stops and reports which worker handled the role and where its report is.
#
# "AI never calls AI directly" — the orchestrator (and the webhook flow) always call this dispatcher;
# the dispatcher mediates worker selection. Consecutive same-worker invocations reuse that worker's
# session for a warm prompt cache: claude (`--session-id`/`--resume`), codex (`exec resume --last`),
# antigravity (`--continue`). Per-run session state is reset at the start of run_auto.sh.

CONTROL_PLANE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$CONTROL_PLANE_DIR"

WORKER_NONRESPONSE_EXIT=75

ROLE=""
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --*) echo "run_worker.sh: unknown flag $arg" >&2; exit 2 ;;
    *) if [ -z "$ROLE" ]; then ROLE="$arg"; else echo "run_worker.sh: unexpected arg $arg" >&2; exit 2; fi ;;
  esac
done

VALID_ROLES="task-check decomposition implementation verification acceptance github linear-report"
if [ -z "$ROLE" ] || [[ " $VALID_ROLES " != *" $ROLE "* ]]; then
  echo "run_worker.sh: role must be one of: $VALID_ROLES (got '${ROLE:-}')" >&2
  exit 2
fi

# Lane support (mirror the worker scripts) so the dispatcher references the same report paths.
RUNNER_LANE="$(printf '%s' "${RUNNER_LANE:-default}" | tr -cd 'a-zA-Z0-9_-')"
[ -z "$RUNNER_LANE" ] && RUNNER_LANE="default"
lane_path() {
  local p="$1"
  if [ "$RUNNER_LANE" = "default" ]; then printf '%s' "$p"; return; fi
  local dir base name ext
  dir="$(dirname "$p")"; base="$(basename "$p")"; ext="${base##*.}"; name="${base%.*}"
  printf '%s/%s.%s.%s' "$dir" "$name" "$RUNNER_LANE" "$ext"
}

# Resolve the ordered worker chain for this role from config/worker_roles.json (fail-open to "").
WORKER_ROLES_FILE="${WORKER_ROLES_FILE:-$CONTROL_PLANE_DIR/config/worker_roles.json}"
CHAIN="$(node -e '
  const fs = require("fs");
  const [file, role] = process.argv.slice(1);
  const ROLES = ["task-check","decomposition","implementation","verification","acceptance","github","linear-report"];
  const WORKERS = ["claude","codex","antigravity"];
  if (!ROLES.includes(role)) { process.stdout.write(""); process.exit(0); }
  try {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    const raw = Array.isArray(cfg[role]) ? cfg[role] : [cfg[role]];
    const seen = new Set(); const out = [];
    for (const w of raw) { if (WORKERS.includes(w) && !seen.has(w)) { seen.add(w); out.push(w); } }
    process.stdout.write(out.join(" "));
  } catch (e) { process.stdout.write(""); }
' "$WORKER_ROLES_FILE" "$ROLE" 2>/dev/null || echo '')"

if [ -z "$CHAIN" ]; then
  echo "run_worker.sh: no valid worker chain for role '$ROLE' in $WORKER_ROLES_FILE; delegating to orchestrator" >&2
  exit "$WORKER_NONRESPONSE_EXIT"
fi

echo "== Worker dispatch: role=$ROLE chain=[$CHAIN] =="

# Map a worker to its run script and report file (lane-aware).
worker_script() {
  case "$1" in
    codex)       printf '%s' "$CONTROL_PLANE_DIR/scripts/ai/run_codex.sh" ;;
    claude)      printf '%s' "$CONTROL_PLANE_DIR/scripts/ai/run_claude.sh" ;;
    antigravity) printf '%s' "$CONTROL_PLANE_DIR/scripts/ai/run_antigravity.sh" ;;
  esac
}
worker_report() {
  case "$1" in
    codex)       lane_path "$CONTROL_PLANE_DIR/docs/ai/60_worker_codex_report.md" ;;
    claude)      lane_path "$CONTROL_PLANE_DIR/docs/ai/55_worker_claude_report.md" ;;
    antigravity) lane_path "$CONTROL_PLANE_DIR/docs/ai/50_worker_antigravity_report.md" ;;
  esac
}
# Each worker script reads a DIFFERENT prompt file. The orchestrator writes ONE canonical role prompt
# and the dispatcher fans it out to whichever worker it picks (so the instruction is worker-agnostic).
worker_prompt() {
  case "$1" in
    codex)       lane_path "$CONTROL_PLANE_DIR/prompts/codex/debug.md" ;;
    claude)      lane_path "$CONTROL_PLANE_DIR/prompts/claude/worker.md" ;;
    antigravity) lane_path "$CONTROL_PLANE_DIR/prompts/antigravity/implement.md" ;;
  esac
}
# Canonical per-role instruction the orchestrator writes once (WORKER_PROMPT_FILE overrides the path).
# When present, it is copied into the selected worker's prompt file before invocation. When absent,
# each worker falls back to its own existing prompt file (backward compatible).
ROLE_PROMPT_SRC="${WORKER_PROMPT_FILE:-$(lane_path "$CONTROL_PLANE_DIR/prompts/roles/$ROLE.md")}"

PREV_WORKER=""
PREV_REPORT=""

for WORKER in $CHAIN; do
  SCRIPT="$(worker_script "$WORKER")"
  REPORT="$(worker_report "$WORKER")"

  if [ "$DRY_RUN" = true ]; then
    HANDOFF=""
    [ -n "$PREV_WORKER" ] && HANDOFF=" (handoff from $PREV_WORKER: $PREV_REPORT)"
    echo "DRY_RUN would invoke: WORKER_ROLE=$ROLE $SCRIPT -> report=$REPORT${HANDOFF}"
    PREV_WORKER="$WORKER"
    PREV_REPORT="$REPORT"
    continue
  fi

  echo "-- dispatch: trying worker '$WORKER' for role '$ROLE' --"

  # Fan out the canonical role instruction into the selected worker's prompt file (if provided).
  if [ -s "$ROLE_PROMPT_SRC" ]; then
    PROMPT_DEST="$(worker_prompt "$WORKER")"
    mkdir -p "$(dirname "$PROMPT_DEST")"
    cp "$ROLE_PROMPT_SRC" "$PROMPT_DEST"
  fi

  # Hand off the previous worker's partial report (usage-limit / non-response continuity).
  HANDOFF_ENV=()
  if [ -n "$PREV_REPORT" ] && [ -s "$PREV_REPORT" ]; then
    HANDOFF_ENV=(WORKER_HANDOFF_FROM="$PREV_WORKER" WORKER_HANDOFF_REPORT="$PREV_REPORT")
  fi

  set +e
  env RUN_WORKER_DISPATCH=1 WORKER_ROLE="$ROLE" WORKER_SELECTED="$WORKER" "${HANDOFF_ENV[@]}" \
    bash "$SCRIPT"
  RC=$?
  set -e

  if [ "$RC" -eq 0 ]; then
    echo "WORKER_DISPATCH_DONE role=$ROLE worker=$WORKER report=$REPORT"
    exit 0
  fi

  # Non-response (75) or any other non-zero exit → hand off to the next worker in the chain.
  echo "WORKER_DISPATCH_HANDOFF role=$ROLE worker=$WORKER exit=$RC -> next in chain" >&2
  PREV_WORKER="$WORKER"
  PREV_REPORT="$REPORT"
done

if [ "$DRY_RUN" = true ]; then
  exit 0
fi

echo "WORKER_DISPATCH_EXHAUSTED role=$ROLE: all workers in [$CHAIN] were non-responsive" >&2
exit "$WORKER_NONRESPONSE_EXIT"
