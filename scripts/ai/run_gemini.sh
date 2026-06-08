#!/usr/bin/env bash
set -euo pipefail

CONTROL_PLANE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$CONTROL_PLANE_DIR/docs/ai"

PROMPT_FILE="$CONTROL_PLANE_DIR/prompts/gemini/implement.md"
REPORT_FILE="$CONTROL_PLANE_DIR/docs/ai/50_worker_gemini_report.md"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

echo "== Gemini CLI: implementation worker =="

if [ -n "${TARGET_REPO:-}" ]; then
  echo "Target repository: $TARGET_REPO"
  gemini --include-directories "$TARGET_REPO" --yolo -p "$(cat "$PROMPT_FILE")" | tee "$REPORT_FILE"
else
  gemini --yolo -p "$(cat "$PROMPT_FILE")" | tee "$REPORT_FILE"
fi
