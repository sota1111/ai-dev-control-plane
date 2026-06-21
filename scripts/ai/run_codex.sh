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

PROMPT_FILE="$(lane_path "$CONTROL_PLANE_DIR/prompts/codex/debug.md")"
REPORT_FILE="$(lane_path "$CONTROL_PLANE_DIR/docs/ai/60_worker_codex_report.md")"
# Cooldown is account-global (worker usage limit is shared across lanes): NOT lane-suffixed.
CODEX_COOLDOWN_FILE="$CONTROL_PLANE_DIR/docs/ai/auto_logs/codex.cooldown.json"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

echo "== Codex CLI: debugging worker =="

# Per-lane WORKER_TIMEOUT (SOT-916). Priority (highest first):
#  1) WORKER_TIMEOUT_<LANE>  — lane-specific override (lane upper-cased, `-` -> `_`)
#  2) WORKER_TIMEOUT          — global override (backward compatible)
#  3) lane default: the long-run lane gets WORKER_TIMEOUT_LONG_RUN (default 21600s/6h) so it is not
#     killed mid-run; every other lane keeps the historical 1800s.
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

# --- All-Claude mode master flag (SOT-993) ---
# Claude が全作業を担当する運用モード。`ALL_CLAUDE_MODE` を真値にすると Gemini/Codex 両ワーカーを
# 一括無効化し、実装も検証も Claude Code が CLAUDE.md「Worker Non-Response Fallback Policy」で代行する。
# このマスターフラグは cooldown pre-check より先に評価される短絡。真値は 1/true/yes/on（大小無視）。
case "$(printf '%s' "${ALL_CLAUDE_MODE:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on)
    echo "ALL_CLAUDE_MODE: all worker delegation disabled by env flag, delegating to Claude" >&2
    exit "$WORKER_NONRESPONSE_EXIT"
    ;;
esac

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
    echo "CODEX_USAGE_LIMIT: detected but reset time unparseable, notifying Discord without cooldown" >&2
    (cd "$CONTROL_PLANE_DIR" && npx tsx src/runner-cli.ts notify-usage-limit-unknown codex) >/dev/null 2>&1 || true
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
