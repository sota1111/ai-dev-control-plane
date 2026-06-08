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

if [ -n "${TARGET_REPO:-}" ]; then
  echo "Target repository: $TARGET_REPO"
  cd "$TARGET_REPO"
fi

codex --sandbox danger-full-access exec "$(cat "$PROMPT_FILE")" | tee "$REPORT_FILE"
