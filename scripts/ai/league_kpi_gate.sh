#!/usr/bin/env bash
# SOT-1896: cross-agent league KPI gate — 1-command reproducible round-robin.
#
# Replaces the saturated self-mirror KPI ("candidate vs own champion mirror win rate,
# Wilson CI lower > 0.5") with a CROSS-AGENT round-robin (総当たり): every champion plays
# every other champion, and each agent's league KPI is its AGGREGATE win rate (Wilson 95% CI)
# over the whole opponent pool. See docs/ai/league-kpi-gate.md for the gate definition.
#
# Match play reuses the existing real driver ptcg-agent-matsu/eval/battle_matsu_take_ume.py,
# which runs each project's actual Kaggle `main.agent` in an isolated subprocess on the real
# `cg` engine. This wrapper only (1) schedules the champion pairings, (2) aggregates the
# per-pairing results into a payoff matrix + per-agent pool CI, and (3) writes the artifacts.
#
# The engine exposes no shuffle-seed API, so results are STATISTICAL (Wilson CI), not
# bit-reproducible — reproducibility is of the manifest (champions, deck, N, provenance) and
# the CIs tighten with N, per the documented screen(small-N)→confirm(large-N) two-stage gate.
#
# Usage:
#   scripts/ai/league_kpi_gate.sh                       # defaults: matsu/take/ume/zero, deck 01, N=6
#   CHAMPIONS="matsu take ume zero" DECK=01 N=6 \
#     RUN_ID=baseline scripts/ai/league_kpi_gate.sh
#   scripts/ai/league_kpi_gate.sh --champions "matsu take ume zero" --deck 01 --n 6 --run-id baseline
#
# Env / flags:
#   CHAMPIONS   space-separated agent labels (must be runnable by the driver). Default
#               "matsu take ume zero". NOTE: fable/sol currently fail under the driver
#               (`agents` module-name collision) — track their inclusion as a follow-up.
#   DECK        deck id from the driver's decks/initial pool used as the MIRROR deck for
#               every pairing (isolates agent skill from deck strength). Default 01.
#   N           matches per pairing (seat-alternating). Default 6 (screen-N).
#   RUN_ID      artifact subdir under artifacts/league-kpi/. Default "baseline".
#   DRIVER_REPO ptcg-agent-matsu checkout (hosts engine + driver). Default /workspaces/ptcg-agent-matsu.
#   DECKS_DIR   deck pool dir (relative to DRIVER_REPO or absolute). Default decks/initial.
#   PER_MATCH_TIMEOUT  seconds per pairing subprocess. Default 900.
set -euo pipefail

CHAMPIONS="${CHAMPIONS:-matsu take ume zero}"
DECK="${DECK:-01}"
N="${N:-6}"
RUN_ID="${RUN_ID:-baseline}"
DRIVER_REPO="${DRIVER_REPO:-/workspaces/ptcg-agent-matsu}"
DECKS_DIR="${DECKS_DIR:-decks/initial}"
PER_MATCH_TIMEOUT="${PER_MATCH_TIMEOUT:-900}"

# --- minimal flag parsing (env vars remain the primary interface) ---
while [ $# -gt 0 ]; do
  case "$1" in
    --champions) CHAMPIONS="$2"; shift 2;;
    --deck) DECK="$2"; shift 2;;
    --n) N="$2"; shift 2;;
    --run-id) RUN_ID="$2"; shift 2;;
    --driver-repo) DRIVER_REPO="$2"; shift 2;;
    --decks-dir) DECKS_DIR="$2"; shift 2;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DRIVER="$DRIVER_REPO/eval/battle_matsu_take_ume.py"
PY="$DRIVER_REPO/venv/bin/python"
[ -x "$PY" ] || PY="python3"
OUT_DIR="$CP_ROOT/artifacts/league-kpi/$RUN_ID"

[ -f "$DRIVER" ] || { echo "error: driver not found: $DRIVER" >&2; exit 1; }
mkdir -p "$OUT_DIR/shards"

echo "league-kpi gate: champions=[$CHAMPIONS] deck=$DECK N=$N run-id=$RUN_ID"
echo "  driver=$DRIVER  out=$OUT_DIR"

# shellcheck disable=SC2206
AGENTS=($CHAMPIONS)
SHARDS=()
for ((i=0; i<${#AGENTS[@]}; i++)); do
  for ((j=i+1; j<${#AGENTS[@]}; j++)); do
    a="${AGENTS[$i]}"; b="${AGENTS[$j]}"
    shard="$OUT_DIR/shards/${a}_vs_${b}.json"
    SHARDS+=("$shard")
    if [ -f "$shard" ]; then
      echo "  skip (done) ${a} vs ${b}"
      continue
    fi
    echo "  run  ${a} vs ${b} (n=$N, deck=$DECK)"
    ( cd "$DRIVER_REPO" && timeout "$PER_MATCH_TIMEOUT" "$PY" "$DRIVER" \
        --n "$N" --seat0 "${a}:${DECK}" --seat1 "${b}:${DECK}" \
        --decks-dir "$DECKS_DIR" --json - ) > "$shard.tmp" 2>>"$OUT_DIR/driver.log"
    mv "$shard.tmp" "$shard"
  done
done

echo "aggregating ${#SHARDS[@]} pairings → payoff matrix + per-agent pool CI"
CHAMPIONS="$CHAMPIONS" RUN_ID="$RUN_ID" OUT_DIR="$OUT_DIR" DECK="$DECK" N="$N" \
  python3 "$SCRIPT_DIR/league_kpi_aggregate.py" "${SHARDS[@]}"

echo "done. artifacts under: ${OUT_DIR#"$CP_ROOT/"}"
