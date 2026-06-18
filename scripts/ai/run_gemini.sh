#!/usr/bin/env bash
set -euo pipefail

CONTROL_PLANE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$CONTROL_PLANE_DIR/docs/ai"

PROMPT_FILE="$CONTROL_PLANE_DIR/prompts/gemini/implement.md"
REPORT_FILE="$CONTROL_PLANE_DIR/docs/ai/50_worker_gemini_report.md"
GEMINI_COOLDOWN_FILE="$CONTROL_PLANE_DIR/docs/ai/auto_logs/gemini.cooldown.json"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

echo "== Gemini CLI: implementation worker =="

WORKER_TIMEOUT="${WORKER_TIMEOUT:-1800}"
WORKER_NONRESPONSE_EXIT=75

# --- Gemini usage-limit cooldown pre-check (auto fallback / auto resume) ---
if [ -f "$GEMINI_COOLDOWN_FILE" ]; then
  NOW_EPOCH="$(date +%s)"
  RESUME_AT="$(node -e "try{const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(Number(d.resumeAtEpoch)||0));}catch(e){process.stdout.write('0');}" "$GEMINI_COOLDOWN_FILE" 2>/dev/null || echo 0)"
  if [ "$RESUME_AT" -gt 0 ] && [ "$NOW_EPOCH" -lt "$RESUME_AT" ]; then
    echo "GEMINI_COOLDOWN_ACTIVE: gemini usage limit until epoch $RESUME_AT (now $NOW_EPOCH), delegating to Claude" >&2
    exit "$WORKER_NONRESPONSE_EXIT"
  fi
  echo "Gemini cooldown expired (now $NOW_EPOCH >= resumeAt $RESUME_AT), clearing and resuming Gemini" >&2
  rm -f "$GEMINI_COOLDOWN_FILE"
fi

if [ -n "${TARGET_REPO:-}" ]; then
  echo "Target repository: $TARGET_REPO"
  set +e
  timeout "${WORKER_TIMEOUT}s" gemini --include-directories "$TARGET_REPO" --yolo -p "$(cat "$PROMPT_FILE")" 2>&1 | tee "$REPORT_FILE"
  EXIT_CODE="${PIPESTATUS[0]}"
  set -e
else
  set +e
  timeout "${WORKER_TIMEOUT}s" gemini --yolo -p "$(cat "$PROMPT_FILE")" 2>&1 | tee "$REPORT_FILE"
  EXIT_CODE="${PIPESTATUS[0]}"
  set -e
fi

# --- Gemini usage-limit detection (set cooldown, delegate to Claude) ---
# Only treat as usage-limit when the run actually FAILED (non-zero exit). A real
# Gemini quota/limit aborts the run, so EXIT_CODE != 0. Gating on this avoids
# false positives when a successful run's report merely mentions these keywords
# (e.g. while implementing usage-limit features, the report contains "usage limit").
if [ "$EXIT_CODE" -ne 0 ] \
  && [ -f "$REPORT_FILE" ] \
  && grep -Ei "usage limit|quota exceeded|resource exhausted|rate limit|RESOURCE_EXHAUSTED|try again at|resets at" "$REPORT_FILE" > /dev/null; then
  mkdir -p "$(dirname "$GEMINI_COOLDOWN_FILE")"
  RESUME_EPOCH="$( (cd "$CONTROL_PLANE_DIR" && npx tsx src/runner-cli.ts parse-usage-limit-epoch < "$REPORT_FILE") 2>/dev/null || true)"
  if [ -n "$RESUME_EPOCH" ]; then
    node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({resumeAtEpoch:Number(process.argv[2]),detectedAt:new Date().toISOString(),reason:'gemini_usage_limit'},null,2));" "$GEMINI_COOLDOWN_FILE" "$RESUME_EPOCH"
    echo "GEMINI_USAGE_LIMIT: cooldown set until epoch $RESUME_EPOCH, delegating to Claude" >&2
  else
    echo "GEMINI_USAGE_LIMIT: detected but reset time unparseable, delegating to Claude (no cooldown)" >&2
  fi
  exit "$WORKER_NONRESPONSE_EXIT"
fi

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
  echo "WORKER_NONRESPONSE: gemini ($REASON)" >&2
  exit "$WORKER_NONRESPONSE_EXIT"
fi
