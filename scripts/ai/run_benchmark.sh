#!/usr/bin/env bash
set -euo pipefail

# SOT-1531: worker-comparison benchmark runner.
#
# Runs the SAME fixed task through ONE harness role while swapping the worker, and auto-collects the
# objective metrics (M4 duration, M5 interruptions, M6 diff size) that were previously hand-transcribed
# from docs/ai/auto_logs (see docs/ai/experiments/SOT-1531-analysis.md, improvement S1/S2). The result
# is a machine-readable metrics JSON that scoreBenchmarkRun() (src/lib/benchmarkScore.ts) can consume.
#
# This is an ORCHESTRATOR-layer tool: it has dispatch authority and calls run_worker.sh per worker.
# It must NOT be invoked from inside a dispatched worker ("AI does not call AI") — it refuses when
# RUN_WORKER_DISPATCH=1 is set.
#
# Usage:
#   scripts/ai/run_benchmark.sh --repo <path> [options]
#
# Options:
#   --repo <path>        Target repo the benchmark task operates on (REQUIRED).
#   --role <role>        Harness role whose worker is swapped (default: implementation).
#   --workers "a b c"    Space-separated workers to compare (default: "claude codex antigravity").
#   --sha <sha>          Fixed SHA to restore the target repo to before each run (apples-to-apples).
#                        Requires --reset to actually restore (destructive; opt-in).
#   --reset              Allow `git reset --hard <sha> && git clean -fd` on the TARGET repo between
#                        runs. Off by default (safety: no destructive git without explicit opt-in).
#   --task <label>       Free-text task label recorded in the metrics (e.g. "T4-doc").
#   --out <file>         Metrics JSON output path
#                        (default: docs/ai/auto_logs/metrics/benchmark-<timestamp>.json).
#   --dry-run            Print what would run without dispatching.
#
# The canonical role instruction the workers execute must already be written to
# prompts/roles/<role>.md (as usual for the dispatcher). This script does not author the task prompt;
# it only pins the worker and measures the run.

CONTROL_PLANE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$CONTROL_PLANE_DIR"

if [ "${RUN_WORKER_DISPATCH:-}" = "1" ]; then
  echo "run_benchmark.sh: refusing to run inside a dispatched worker (AI does not call AI)." >&2
  echo "  Run this from the orchestrator/human shell instead." >&2
  exit 2
fi

ROLE="implementation"
WORKERS="claude codex antigravity"
REPO=""
SHA=""
DO_RESET=false
TASK_LABEL=""
OUT=""
DRY_RUN=false

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)    REPO="${2:-}"; shift 2 ;;
    --role)    ROLE="${2:-}"; shift 2 ;;
    --workers) WORKERS="${2:-}"; shift 2 ;;
    --sha)     SHA="${2:-}"; shift 2 ;;
    --reset)   DO_RESET=true; shift ;;
    --task)    TASK_LABEL="${2:-}"; shift 2 ;;
    --out)     OUT="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "run_benchmark.sh: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

VALID_ROLES="task-check decomposition implementation verification acceptance github linear-report"
if [[ " $VALID_ROLES " != *" $ROLE "* ]]; then
  echo "run_benchmark.sh: --role must be one of: $VALID_ROLES (got '$ROLE')" >&2
  exit 2
fi
if [ -z "$REPO" ] || [ ! -d "$REPO" ]; then
  echo "run_benchmark.sh: --repo <path> is required and must be a directory (got '${REPO:-}')" >&2
  exit 2
fi
if [ "$DO_RESET" = true ] && [ -z "$SHA" ]; then
  echo "run_benchmark.sh: --reset requires --sha <sha>" >&2
  exit 2
fi

TS="$(date +%Y%m%d_%H%M%S)"
[ -z "$OUT" ] && OUT="$CONTROL_PLANE_DIR/docs/ai/auto_logs/metrics/benchmark-$TS.json"
mkdir -p "$(dirname "$OUT")"
LOG_DIR="$CONTROL_PLANE_DIR/docs/ai/auto_logs/metrics/logs-$TS"
mkdir -p "$LOG_DIR"

# Snapshot the starting SHA so M6 (diff size) is measured relative to a fixed baseline.
BASE_SHA="$SHA"
if [ -z "$BASE_SHA" ]; then
  BASE_SHA="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo '')"
fi

echo "== run_benchmark: role=$ROLE workers=[$WORKERS] repo=$REPO base=$BASE_SHA reset=$DO_RESET =="

# Build metrics JSON incrementally.
RESULTS=()

restore_repo() {
  if [ "$DO_RESET" = true ]; then
    echo "-- reset $REPO -> $SHA (git reset --hard && git clean -fd) --"
    git -C "$REPO" reset --hard "$SHA"
    git -C "$REPO" clean -fd
  else
    # Non-destructive: require a clean tree so each run starts from the same state.
    if [ -n "$(git -C "$REPO" status --porcelain 2>/dev/null)" ]; then
      echo "run_benchmark.sh: target repo '$REPO' has uncommitted changes; commit/stash or pass --reset --sha." >&2
      return 1
    fi
  fi
  return 0
}

for WORKER in $WORKERS; do
  case "$WORKER" in claude|codex|antigravity) ;; *)
    echo "run_benchmark.sh: skipping invalid worker '$WORKER'" >&2; continue ;;
  esac

  if ! restore_repo; then
    RESULTS+=("$(printf '{"worker":"%s","role":"%s","status":"skipped-dirty-repo"}' "$WORKER" "$ROLE")")
    continue
  fi

  # Pin ONLY the target role to this single worker; other roles keep the config default.
  ROLES_TMP="$LOG_DIR/worker_roles.$WORKER.json"
  node -e '
    const fs = require("fs");
    const [base, role, worker, out] = process.argv.slice(1);
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(base, "utf8")); } catch (e) {}
    cfg[role] = [worker];
    fs.writeFileSync(out, JSON.stringify(cfg, null, 2));
  ' "$CONTROL_PLANE_DIR/config/worker_roles.json" "$ROLE" "$WORKER" "$ROLES_TMP"

  RUN_LOG="$LOG_DIR/run.$WORKER.log"

  if [ "$DRY_RUN" = true ]; then
    echo "DRY_RUN would run: WORKER_ROLES_FILE=$ROLES_TMP TARGET_REPO=$REPO run_worker.sh $ROLE (worker=$WORKER)"
    RESULTS+=("$(printf '{"worker":"%s","role":"%s","status":"dry-run"}' "$WORKER" "$ROLE")")
    continue
  fi

  echo "-- benchmark run: worker=$WORKER role=$ROLE --"
  START_MS="$(date +%s%3N)"
  set +e
  env WORKER_ROLES_FILE="$ROLES_TMP" TARGET_REPO="$REPO" \
    bash "$CONTROL_PLANE_DIR/scripts/ai/run_worker.sh" "$ROLE" >"$RUN_LOG" 2>&1
  RC=$?
  set -e
  END_MS="$(date +%s%3N)"
  DURATION_MS=$(( END_MS - START_MS ))

  # M5 interruptions = handoffs + exhaustion observed in the dispatcher output.
  INTERRUPTIONS="$(grep -cE 'WORKER_DISPATCH_HANDOFF|WORKER_DISPATCH_EXHAUSTED' "$RUN_LOG" 2>/dev/null || echo 0)"

  # M6 diff size relative to the fixed baseline (files / insertions / deletions).
  DIFF_FILES=0; DIFF_INS=0; DIFF_DEL=0
  if [ -n "$BASE_SHA" ]; then
    read -r DIFF_FILES DIFF_INS DIFF_DEL < <(
      git -C "$REPO" diff --numstat "$BASE_SHA" 2>/dev/null \
        | awk '{f++; ins+=$1; del+=$2} END {printf "%d %d %d", f+0, ins+0, del+0}'
    )
  fi

  # The dispatcher prints the winning report path on success.
  REPORT_PATH="$(grep -oE 'WORKER_DISPATCH_DONE .*report=[^ ]+' "$RUN_LOG" 2>/dev/null | sed -E 's/.*report=//' | tail -1 || true)"
  GATE="pass"; [ "$RC" -ne 0 ] && GATE="fail"

  RESULTS+=("$(node -e '
    const [worker, role, rc, dur, intr, df, di, dd, gate, report, log] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      worker, role,
      exitCode: Number(rc),
      m1GatePass: gate === "pass",
      m4DurationMs: Number(dur),
      m5Interruptions: Number(intr),
      m6Diff: { files: Number(df), insertions: Number(di), deletions: Number(dd) },
      reportPath: report || null,
      runLog: log,
    }));
  ' "$WORKER" "$ROLE" "$RC" "$DURATION_MS" "$INTERRUPTIONS" "$DIFF_FILES" "$DIFF_INS" "$DIFF_DEL" "$GATE" "${REPORT_PATH:-}" "$RUN_LOG")")

  echo "   worker=$WORKER exit=$RC duration_ms=$DURATION_MS interruptions=$INTERRUPTIONS diff=$DIFF_FILES/$DIFF_INS/$DIFF_DEL"
done

# Emit the aggregate metrics JSON.
{
  printf '{\n'
  printf '  "issue": "SOT-1531",\n'
  printf '  "role": "%s",\n' "$ROLE"
  printf '  "task": "%s",\n' "$TASK_LABEL"
  printf '  "baseSha": "%s",\n' "$BASE_SHA"
  printf '  "repo": "%s",\n' "$REPO"
  printf '  "timestamp": "%s",\n' "$TS"
  printf '  "runs": [%s]\n' "$(IFS=,; echo "${RESULTS[*]:-}")"
  printf '}\n'
} > "$OUT"

echo "== BENCHMARK_DONE out=$OUT logs=$LOG_DIR =="
echo "Next: feed each run's M4/M5/M6 (+ hand-scored M2/M8) into scoreBenchmarkRun() and record in"
echo "      docs/ai/experiments/SOT-1531-results.md."
