#!/usr/bin/env bash
# SOT-1439 / P5 — daily aggregation of runner run outcomes.
#
# Parses the structured [OUTCOME] lines in docs/ai/auto_logs/auto_runner.log and prints
# success / usage-limit / failure rates. Intended for a daily cron or ad-hoc inspection.
#
# Usage:
#   scripts/ai/aggregate_outcomes.sh [windowHours] [--json] [--promote] [--threshold N]
#     windowHours    : only count the last N hours (default 24; 0 = all-time)
#     --promote      : also list recurring failure kinds as promotion candidates (SOT-1575)
#     --threshold N  : min occurrences for a promotion candidate (default 3)
#
# Examples:
#   scripts/ai/aggregate_outcomes.sh                     # last 24h, human readable
#   scripts/ai/aggregate_outcomes.sh 0                   # all-time
#   scripts/ai/aggregate_outcomes.sh 24 --json
#   scripts/ai/aggregate_outcomes.sh 0 --promote         # all-time + 昇格候補（閾値3）
#   scripts/ai/aggregate_outcomes.sh 0 --promote --threshold 5
set -euo pipefail

CONTROL_PLANE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

WINDOW="24"
PASS_THROUGH=()
expect_value=0   # set after --threshold so its numeric value is forwarded, not read as the window
for arg in "$@"; do
  if [ "$expect_value" = "1" ]; then
    PASS_THROUGH+=("$arg"); expect_value=0; continue
  fi
  case "$arg" in
    --threshold) PASS_THROUGH+=("$arg"); expect_value=1 ;;   # next token is its value
    --json|--promote) PASS_THROUGH+=("$arg") ;;              # flags forwarded to the CLI
    ''|*[!0-9.]*) PASS_THROUGH+=("$arg") ;;                  # other non-numeric args forwarded
    *) WINDOW="$arg" ;;                                      # first numeric token is the window
  esac
done

cd "$CONTROL_PLANE_DIR"
exec npx tsx src/runner-cli.ts aggregate-outcomes "$WINDOW" "${PASS_THROUGH[@]}"
