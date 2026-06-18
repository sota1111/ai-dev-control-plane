#!/usr/bin/env bash
set -euo pipefail

CONTROL_PLANE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$CONTROL_PLANE_DIR/docs/ai"

PROMPT_FILE="$CONTROL_PLANE_DIR/prompts/codex/debug.md"
REPORT_FILE="$CONTROL_PLANE_DIR/docs/ai/60_worker_codex_report.md"
CODEX_COOLDOWN_FILE="$CONTROL_PLANE_DIR/docs/ai/auto_logs/codex.cooldown.json"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

echo "== Codex CLI: debugging worker =="

WORKER_TIMEOUT="${WORKER_TIMEOUT:-1800}"
WORKER_NONRESPONSE_EXIT=75

# --- Codex usage-limit cooldown pre-check (auto fallback / auto resume) ---
# While Codex is usage-limited we skip invoking it and exit with the dedicated
# non-response code so the orchestrator delegates to Claude. Once the reset time
# (resumeAtEpoch) has passed we clear the cooldown and resume Codex automatically.
if [ -f "$CODEX_COOLDOWN_FILE" ]; then
  NOW_EPOCH="$(date +%s)"
  RESUME_AT="$(node -e "try{const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(Number(d.resumeAtEpoch)||0));}catch(e){process.stdout.write('0');}" "$CODEX_COOLDOWN_FILE" 2>/dev/null || echo 0)"
  if [ "$RESUME_AT" -gt 0 ] && [ "$NOW_EPOCH" -lt "$RESUME_AT" ]; then
    echo "CODEX_COOLDOWN_ACTIVE: codex usage limit until epoch $RESUME_AT (now $NOW_EPOCH), delegating to Claude" >&2
    exit "$WORKER_NONRESPONSE_EXIT"
  fi
  echo "Codex cooldown expired (now $NOW_EPOCH >= resumeAt $RESUME_AT), clearing and resuming Codex" >&2
  rm -f "$CODEX_COOLDOWN_FILE"
fi

if [ -n "${TARGET_REPO:-}" ]; then
  echo "Target repository: $TARGET_REPO"
  cd "$TARGET_REPO"
fi

set +e
# Capture stderr as well as stdout: Codex prints the usage-limit notice
# ("You've hit your usage limit ... try again at <date>") to stderr, which the
# usage-limit detection below needs to see.
timeout "${WORKER_TIMEOUT}s" codex --sandbox danger-full-access exec "$(cat "$PROMPT_FILE")" 2>&1 | tee "$REPORT_FILE"
EXIT_CODE="${PIPESTATUS[0]}"
set -e

# --- Codex usage-limit detection (set cooldown, delegate to Claude) ---
# Codex prints "You've hit your usage limit ... try again at <date>" and exits
# non-zero. Detect it, persist the reset time so future runs can auto-resume, and
# exit with the non-response code so the orchestrator falls back to Claude now.
if [ -f "$REPORT_FILE" ] \
  && grep -qi "usage limit" "$REPORT_FILE" \
  && grep -qi "try again at" "$REPORT_FILE"; then
  mkdir -p "$(dirname "$CODEX_COOLDOWN_FILE")"
  RESUME_EPOCH="$( (cd "$CONTROL_PLANE_DIR" && npx tsx src/runner-cli.ts parse-usage-limit-epoch < "$REPORT_FILE") 2>/dev/null || true)"
  if [ -n "$RESUME_EPOCH" ]; then
    node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({resumeAtEpoch:Number(process.argv[2]),detectedAt:new Date().toISOString(),reason:'codex_usage_limit'},null,2));" "$CODEX_COOLDOWN_FILE" "$RESUME_EPOCH"
    echo "CODEX_USAGE_LIMIT: cooldown set until epoch $RESUME_EPOCH, delegating to Claude" >&2
    (cd "$CONTROL_PLANE_DIR" && npx tsx src/runner-cli.ts notify-cooldown codex) >/dev/null 2>&1 || true
  else
    echo "CODEX_USAGE_LIMIT: detected but reset time unparseable, delegating to Claude (no cooldown)" >&2
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
  echo "WORKER_NONRESPONSE: codex ($REASON)" >&2
  exit "$WORKER_NONRESPONSE_EXIT"
fi
