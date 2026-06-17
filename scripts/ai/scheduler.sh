#!/usr/bin/env bash
set -euo pipefail

# Compute script directory before any cd
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Rollback path to legacy Bash implementation
if [[ "${SCHEDULER_IMPL:-}" == "bash" ]]; then
  exec bash "$SCRIPT_DIR/scheduler.legacy.sh" "$@"
else
  # Default to Node.js implementation
  exec node "$REPO_ROOT/src/scheduler.js" "$@"
fi
