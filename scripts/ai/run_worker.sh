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

# SOT-1591: `solo` is a synthetic dispatch role — one worker runs the whole lifecycle in one session.
# Its primary is `__solo__`; when handoff is enabled, remaining workers follow the task-check chain.
VALID_ROLES="task-check decomposition implementation verification acceptance github linear-report solo"
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
# SOT-1555: when PIPELINE_PINNED_WORKER is set (task-check flagged the issue implementation-not-required),
# the pinned worker is moved to the FRONT of the chain so the whole lifecycle stays on one AI with no
# cross-worker handoff. This is a reorder, not a replacement — the rest of the chain remains as fallback,
# so a non-responsive pinned worker still hands off (fail-open). Mirrors reorderChainForPin() in
# src/lib/workerRoles.ts (the unit-tested reference spec).
WORKER_ROLES_FILE="${WORKER_ROLES_FILE:-$CONTROL_PLANE_DIR/config/worker_roles.json}"
CHAIN="$(PIPELINE_PINNED_WORKER="${PIPELINE_PINNED_WORKER:-}" node -e '
  const fs = require("fs");
  const [file, role] = process.argv.slice(1);
  const ROLES = ["task-check","decomposition","implementation","verification","acceptance","github","linear-report","solo"];
  const WORKERS = ["claude","codex","antigravity"];
  if (!ROLES.includes(role)) { process.stdout.write(""); process.exit(0); }
  try {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    // Solo keeps one worker responsible for the whole lifecycle, but an unavailable primary may hand
    // the whole lifecycle to the remaining configured workers. handoff=off below keeps it primary-only.
    const raw = role === "solo"
      ? [cfg.__solo__, ...(Array.isArray(cfg["task-check"]) ? cfg["task-check"] : [cfg["task-check"]])]
      : (Array.isArray(cfg[role]) ? cfg[role] : [cfg[role]]);
    const seen = new Set(); let out = [];
    for (const w of raw) { if (WORKERS.includes(w) && !seen.has(w)) { seen.add(w); out.push(w); } }
    const pin = process.env.PIPELINE_PINNED_WORKER || "";
    if (WORKERS.includes(pin) && out.includes(pin)) {
      out = [pin, ...out.filter((w) => w !== pin)];
    }
    // Linear `workers: handoff=off` disables cross-worker fallback for this issue.
    if (cfg.__handoff__ === false) out = out.slice(0, 1);
    process.stdout.write(out.join(" "));
  } catch (e) { process.stdout.write(""); }
' "$WORKER_ROLES_FILE" "$ROLE" 2>/dev/null || echo '')"

if [ -z "$CHAIN" ]; then
  echo "run_worker.sh: no valid worker chain for role '$ROLE' in $WORKER_ROLES_FILE; delegating to orchestrator" >&2
  exit "$WORKER_NONRESPONSE_EXIT"
fi

if [ -n "${PIPELINE_PINNED_WORKER:-}" ]; then
  echo "== Worker dispatch: role=$ROLE chain=[$CHAIN] (pinned worker=$PIPELINE_PINNED_WORKER) =="
else
  echo "== Worker dispatch: role=$ROLE chain=[$CHAIN] =="
fi

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
# SOT-1583: per-issue model selection. The Linear directive `workers: role=worker:model` records a
# model for a (role, worker) pair in the `__models__` section of $WORKER_ROLES_FILE (written by
# runner-cli resolve-worker-roles). Look up the model for the (role, worker) we are about to invoke and
# pass it to that worker's run script via its model env var (CODEX_MODEL / AGY_MODEL / CLAUDE_MODEL). No
# model recorded → print empty → the run script keeps its default model (fully backward compatible).
worker_model() {
  # args: role worker → prints the model string (empty when none)
  node -e '
    const fs = require("fs");
    const [file, role, worker] = process.argv.slice(1);
    try {
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      const m = cfg && cfg.__models__ && cfg.__models__[role] && cfg.__models__[role][worker];
      process.stdout.write(typeof m === "string" ? m : "");
    } catch (e) { process.stdout.write(""); }
  ' "$WORKER_ROLES_FILE" "$1" "$2" 2>/dev/null || echo ''
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

# ── SOT-1549: per-leg metrics auto-collection ────────────────────────────────────────────────────
# The dispatcher (NOT an AI) records each leg's objective metrics as a side-effect and shapes them via
# src/lib/legMetricsCli.ts into docs/ai/auto_logs/metrics/. This replaces the hand-written benchmark
# JSON that run_benchmark.sh could not produce from inside a dispatched worker ("AI does not call AI").
# Disable with LEG_METRICS=0. The M1 gate breakdown (lint/typecheck/test) is collected only when
# LEG_METRICS_GATE is truthy (default off: the full suite is the verification role's job and running it
# per leg is expensive); when off, m1GatePass keeps its structured shape with null sub-gates.
LEG_METRICS="${LEG_METRICS:-1}"
LEG_METRICS_DIR="${LEG_METRICS_DIR:-$CONTROL_PLANE_DIR/docs/ai/auto_logs/metrics}"
# The repo whose diff/gate is measured: the target repo when set, else this control-plane repo.
METRICS_REPO="${TARGET_REPO:-$CONTROL_PLANE_DIR}"
# Issue id for the metrics filename: prefer the injected env, else parse the pipeline context.
LEG_ISSUE="${WEBHOOK_ISSUE_ID:-}"
if [ -z "$LEG_ISSUE" ] && [ -f "$CONTROL_PLANE_DIR/docs/ai/pipeline/context.md" ]; then
  LEG_ISSUE="$(sed -n 's/^- Target Linear issue:[[:space:]]*//p' "$CONTROL_PLANE_DIR/docs/ai/pipeline/context.md" | head -1)"
fi

_LEG_TSX_BIN="$CONTROL_PLANE_DIR/node_modules/.bin/tsx"
truthy() { case "${1:-}" in 1|true|yes|on|TRUE|YES|ON) return 0 ;; *) return 1 ;; esac; }

# Run the quality gate in the metrics repo, echoing "<lint> <typecheck> <test>" exit codes (empty when
# a script is absent). Best-effort; never aborts the caller.
collect_gate() {
  local repo="$1" lint="" tc="" test=""
  if [ -f "$repo/package.json" ]; then
    if node -e 'process.exit(require(process.argv[1]).scripts?.lint?0:1)' "$repo/package.json" 2>/dev/null; then
      (cd "$repo" && npm run lint >/dev/null 2>&1); lint=$?
    fi
    if node -e 'process.exit(require(process.argv[1]).scripts?.typecheck?0:1)' "$repo/package.json" 2>/dev/null; then
      (cd "$repo" && npm run typecheck >/dev/null 2>&1); tc=$?
    fi
    if node -e 'process.exit(require(process.argv[1]).scripts?.test?0:1)' "$repo/package.json" 2>/dev/null; then
      (cd "$repo" && npm test >/dev/null 2>&1); test=$?
    fi
  fi
  printf '%s %s %s' "$lint" "$tc" "$test"
}

# Emit one leg's metrics JSON. Args: worker seq exit start_ms end_ms handoff_from report base_sha
emit_leg_metrics() {
  truthy "$LEG_METRICS" || return 0
  local worker="$1" seq="$2" rc="$3" start_ms="$4" end_ms="$5" handoff="$6" report="$7" base="$8"
  [ -x "$_LEG_TSX_BIN" ] || return 0

  local numstat_file gate_lint="" gate_tc="" gate_test=""
  numstat_file="$(mktemp)"
  if [ -n "$base" ]; then
    git -C "$METRICS_REPO" diff --numstat "$base" >"$numstat_file" 2>/dev/null || : >"$numstat_file"
  fi
  if truthy "${LEG_METRICS_GATE:-}"; then
    read -r gate_lint gate_tc gate_test <<<"$(collect_gate "$METRICS_REPO")"
  fi

  local gate_args=()
  [ -n "$gate_lint" ] && gate_args+=(--lint-exit "$gate_lint")
  [ -n "$gate_tc" ] && gate_args+=(--typecheck-exit "$gate_tc")
  [ -n "$gate_test" ] && gate_args+=(--test-exit "$gate_test")
  local handoff_args=()
  [ -n "$handoff" ] && handoff_args+=(--handoff-from "$handoff")

  local written
  written="$("$_LEG_TSX_BIN" "$CONTROL_PLANE_DIR/src/lib/legMetricsCli.ts" \
    --issue "${LEG_ISSUE:-}" --role "$ROLE" --worker "$worker" --sequence "$seq" \
    --exit "$rc" --start-ms "$start_ms" --end-ms "$end_ms" \
    --numstat-file "$numstat_file" "${gate_args[@]}" "${handoff_args[@]}" \
    --report "$report" --repo "$METRICS_REPO" --out-dir "$LEG_METRICS_DIR" 2>/dev/null || true)"
  rm -f "$numstat_file"
  [ -n "$written" ] && echo "LEG_METRICS_EMITTED role=$ROLE worker=$worker seq=$seq file=$written"
  return 0
}
# ─────────────────────────────────────────────────────────────────────────────────────────────────

PREV_WORKER=""
PREV_REPORT=""
LEG_SEQ=0

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
    # SOT-1577: every dispatched worker posts short progress updates to Discord DIRECTLY while it works
    # (the end-of-run report is still sent automatically). Appended after cp so it applies to every role
    # and every worker in one place. Best-effort — notify_discord.sh always exits 0.
    cat >> "$PROMPT_DEST" <<'PROGRESS_NOTIFY'

---

## Progress notifications to Discord (during your work — DO THIS)
While you work, post short progress updates to Discord DIRECTLY by running, from the control-plane repo
root (`/workspaces/ai-dev-control-plane`):

    bash scripts/ai/notify_discord.sh "<one-line progress update>"

- Post at minimum: (1) when you START this role, and (2) at each meaningful milestone (e.g. plan fixed,
  backend done, tests passing, blocked-on-X). Keep each message to 1–3 lines.
- The issue id / role / worker prefix is added automatically — pass only the human-readable message.
- This is best-effort and never blocks your task; the full end-of-run report is still sent
  automatically, so do NOT paste the whole report here — just short live updates.
PROGRESS_NOTIFY
  fi

  # Hand off the previous worker's partial report (usage-limit / non-response continuity).
  HANDOFF_ENV=()
  if [ -n "$PREV_REPORT" ] && [ -s "$PREV_REPORT" ]; then
    HANDOFF_ENV=(WORKER_HANDOFF_FROM="$PREV_WORKER" WORKER_HANDOFF_REPORT="$PREV_REPORT")
  fi

  # SOT-1583: resolve the per-issue model pin for this (role, worker) and pass it to the run script via
  # that worker's model env var. Absent → don't set it, so the run script keeps its default model.
  MODEL_ENV=()
  WORKER_MODEL="$(worker_model "$ROLE" "$WORKER")"
  if [ -n "$WORKER_MODEL" ]; then
    case "$WORKER" in
      codex)       MODEL_ENV=(CODEX_MODEL="$WORKER_MODEL") ;;
      antigravity) MODEL_ENV=(AGY_MODEL="$WORKER_MODEL") ;;
      claude)      MODEL_ENV=(CLAUDE_MODEL="$WORKER_MODEL") ;;
    esac
    echo "-- model override: role '$ROLE' worker '$WORKER' → model '$WORKER_MODEL' --"
  fi

  # SOT-1549: snapshot the metrics-repo baseline + start time so this leg's M4/M6 are measured.
  LEG_BASE_SHA=""
  if truthy "$LEG_METRICS"; then
    LEG_BASE_SHA="$(git -C "$METRICS_REPO" rev-parse HEAD 2>/dev/null || echo '')"
  fi
  LEG_START_MS="$(date +%s%3N)"

  set +e
  env RUN_WORKER_DISPATCH=1 WORKER_ROLE="$ROLE" WORKER_SELECTED="$WORKER" "${HANDOFF_ENV[@]}" "${MODEL_ENV[@]}" \
    bash "$SCRIPT"
  RC=$?
  set -e

  LEG_END_MS="$(date +%s%3N)"
  # Emit this leg's metrics (M1 gate breakdown / M4 duration / M5 handoffs-so-far / M6 diff).
  emit_leg_metrics "$WORKER" "$LEG_SEQ" "$RC" "$LEG_START_MS" "$LEG_END_MS" \
    "$PREV_WORKER" "$REPORT" "$LEG_BASE_SHA" || true
  LEG_SEQ=$((LEG_SEQ + 1))

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
