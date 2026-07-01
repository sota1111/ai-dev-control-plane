#!/usr/bin/env bash
# SOT-1439 / P5 — daily aggregation of runner run outcomes.
#
# Parses the structured [OUTCOME] lines in docs/ai/auto_logs/auto_runner.log and prints
# success / usage-limit / failure rates. Intended for a daily cron or ad-hoc inspection.
#
# Usage:
#   scripts/ai/aggregate_outcomes.sh [windowHours] [--json]
#     windowHours : only count the last N hours (default 24; 0 = all-time)
#
# Examples:
#   scripts/ai/aggregate_outcomes.sh          # last 24h, human readable
#   scripts/ai/aggregate_outcomes.sh 0        # all-time
#   scripts/ai/aggregate_outcomes.sh 24 --json
set -euo pipefail

CONTROL_PLANE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

WINDOW="24"
JSON_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --json) JSON_FLAG="--json" ;;
    ''|*[!0-9.]*) : ;;   # ignore non-numeric args
    *) WINDOW="$arg" ;;
  esac
done

cd "$CONTROL_PLANE_DIR"
exec npx tsx src/runner-cli.ts aggregate-outcomes "$WINDOW" $JSON_FLAG
