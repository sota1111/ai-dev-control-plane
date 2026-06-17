#!/usr/bin/env bash
set -euo pipefail

CONTROL_PLANE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$CONTROL_PLANE_DIR/docs/ai"

PROMPT_FILE="$CONTROL_PLANE_DIR/prompts/codex/debug.md"
REPORT_FILE="$CONTROL_PLANE_DIR/docs/ai/60_worker_codex_report.md"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

echo "== Codex CLI: debugging worker =="

WORKER_TIMEOUT="${WORKER_TIMEOUT:-1800}"
WORKER_NONRESPONSE_EXIT=75

if [ -n "${TARGET_REPO:-}" ]; then
  echo "Target repository: $TARGET_REPO"
  cd "$TARGET_REPO"
fi

set +e
timeout "${WORKER_TIMEOUT}s" codex --sandbox danger-full-access exec "$(cat "$PROMPT_FILE")" | tee "$REPORT_FILE"
EXIT_CODE="${PIPESTATUS[0]}"
set -e

# Validation logic
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
  echo "WORKER_NONRESPONSE: codex ($REASON)" >&2
  exit "$WORKER_NONRESPONSE_EXIT"
fi
