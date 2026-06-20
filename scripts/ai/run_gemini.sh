#!/usr/bin/env bash
set -euo pipefail

CONTROL_PLANE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$CONTROL_PLANE_DIR/docs/ai"

# Lane support (SOT-916 / SOT-911 案②): worker artifacts are lane-aware so parallel lanes don't
# overwrite each other's report/prompt files. The default lane keeps the historical paths/timeout
# (backward compatible); a non-default lane inserts `.<lane>` before the file extension. The lane is
# sanitized the same way as src/runner.ts (`[a-zA-Z0-9_-]`) so it can never escape the directory.
RUNNER_LANE="$(printf '%s' "${RUNNER_LANE:-default}" | tr -cd 'a-zA-Z0-9_-')"
[ -z "$RUNNER_LANE" ] && RUNNER_LANE="default"
LONG_RUN_LANE="$(printf '%s' "${LONG_RUN_LANE:-long-run}" | tr -cd 'a-zA-Z0-9_-')"
[ -z "$LONG_RUN_LANE" ] && LONG_RUN_LANE="long-run"

# Insert `.<lane>` before the extension for non-default lanes; default lane is returned unchanged.
lane_path() {
  local p="$1"
  if [ "$RUNNER_LANE" = "default" ]; then
    printf '%s' "$p"
    return
  fi
  local dir base name ext
  dir="$(dirname "$p")"
  base="$(basename "$p")"
  ext="${base##*.}"
  name="${base%.*}"
  printf '%s/%s.%s.%s' "$dir" "$name" "$RUNNER_LANE" "$ext"
}

PROMPT_FILE="$(lane_path "$CONTROL_PLANE_DIR/prompts/gemini/implement.md")"
REPORT_FILE="$(lane_path "$CONTROL_PLANE_DIR/docs/ai/50_worker_gemini_report.md")"
# Cooldown is account-global (worker usage limit is shared across lanes): NOT lane-suffixed.
GEMINI_COOLDOWN_FILE="$CONTROL_PLANE_DIR/docs/ai/auto_logs/gemini.cooldown.json"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

echo "== Gemini CLI: implementation worker =="

# Per-lane WORKER_TIMEOUT (SOT-916). Priority (highest first):
#  1) WORKER_TIMEOUT_<LANE>  — lane-specific override (lane upper-cased, `-` -> `_`)
#  2) WORKER_TIMEOUT          — global override (backward compatible)
#  3) lane default: the long-run lane gets WORKER_TIMEOUT_LONG_RUN (default 21600s/6h) so it is not
#     killed mid-implementation; every other lane keeps the historical 1800s.
DEFAULT_WORKER_TIMEOUT=1800
LONG_RUN_WORKER_TIMEOUT="${WORKER_TIMEOUT_LONG_RUN:-21600}"
LANE_ENV_KEY="WORKER_TIMEOUT_$(printf '%s' "$RUNNER_LANE" | tr 'a-z-' 'A-Z_')"
LANE_TIMEOUT_OVERRIDE="${!LANE_ENV_KEY:-}"
if [ -n "$LANE_TIMEOUT_OVERRIDE" ]; then
  WORKER_TIMEOUT="$LANE_TIMEOUT_OVERRIDE"
elif [ -n "${WORKER_TIMEOUT:-}" ]; then
  WORKER_TIMEOUT="$WORKER_TIMEOUT"
elif [ "$RUNNER_LANE" = "$LONG_RUN_LANE" ]; then
  WORKER_TIMEOUT="$LONG_RUN_WORKER_TIMEOUT"
else
  WORKER_TIMEOUT="$DEFAULT_WORKER_TIMEOUT"
fi
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
  && grep -Ei "usage limit|quota exceeded|resource exhausted|rate limit|RESOURCE_EXHAUSTED|try again at|resets at|exhausted your daily quota|daily quota|429|too many requests|quota exceeded for quota metric|please retry in" "$REPORT_FILE" > /dev/null; then
  mkdir -p "$(dirname "$GEMINI_COOLDOWN_FILE")"
  RESUME_EPOCH="$( (cd "$CONTROL_PLANE_DIR" && npx tsx src/runner-cli.ts parse-usage-limit-epoch < "$REPORT_FILE") 2>/dev/null || true)"
  if [ -n "$RESUME_EPOCH" ]; then
    node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({resumeAtEpoch:Number(process.argv[2]),detectedAt:new Date().toISOString(),reason:'gemini_usage_limit'},null,2));" "$GEMINI_COOLDOWN_FILE" "$RESUME_EPOCH"
    echo "GEMINI_USAGE_LIMIT: cooldown set until epoch $RESUME_EPOCH, delegating to Claude" >&2
    (cd "$CONTROL_PLANE_DIR" && npx tsx src/runner-cli.ts notify-cooldown gemini) >/dev/null 2>&1 || true
  else
    echo "GEMINI_USAGE_LIMIT: detected but reset time unparseable, notifying Discord without cooldown" >&2
    (cd "$CONTROL_PLANE_DIR" && npx tsx src/runner-cli.ts notify-usage-limit-unknown gemini) >/dev/null 2>&1 || true
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
