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

# SOT-1514 / P4: run runner-cli via the locally-installed tsx binary instead of `npx tsx`.
# `npx` re-resolves the `tsx` package on every invocation (a few hundred ms each), and these
# scripts spawn runner-cli several times per worker run. Resolving the binary once here and
# calling it directly removes that per-call npx overhead. Falls back to `npx tsx` when the
# local bin is missing (e.g. deps not installed), preserving the previous behavior.
_TSX_BIN="$CONTROL_PLANE_DIR/node_modules/.bin/tsx"
run_cli() {
  if [ -x "$_TSX_BIN" ]; then
    (cd "$CONTROL_PLANE_DIR" && "$_TSX_BIN" src/runner-cli.ts "$@")
  else
    (cd "$CONTROL_PLANE_DIR" && npx tsx src/runner-cli.ts "$@")
  fi
}

PROMPT_FILE="$(lane_path "$CONTROL_PLANE_DIR/prompts/codex/debug.md")"
REPORT_FILE="$(lane_path "$CONTROL_PLANE_DIR/docs/ai/60_worker_codex_report.md")"
# Cooldown is account-global (worker usage limit is shared across lanes): NOT lane-suffixed.
CODEX_COOLDOWN_FILE="$CONTROL_PLANE_DIR/docs/ai/auto_logs/codex.cooldown.json"
# Same-AI session reuse marker (SOT-1459): present once this run has created a Codex session, so a
# later same-run Codex invocation resumes it (warm prompt cache). run_auto.sh clears it per run.
CODEX_SESSION_MARKER="$(lane_path "$CONTROL_PLANE_DIR/docs/ai/auto_logs/codex_worker_session.marker")"

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

# --- Per-role gate (DIRECT invocation only; SOT-1459) ---
# Worker selection is owned by the dispatcher `scripts/ai/run_worker.sh`, which reads the role's
# ordered chain from config/worker_roles.json and sets RUN_WORKER_DISPATCH=1 when it picks a worker.
# Under dispatch we therefore skip this gate. For a DIRECT/legacy call with WORKER_ROLE set, exit 75
# if `codex` is not in the role's chain (fail-open on unset/unknown/broken config). Evaluated before
# CODEX_DISABLED (per-worker availability) / cooldown.
WORKER_ROLES_FILE="${WORKER_ROLES_FILE:-$CONTROL_PLANE_DIR/config/worker_roles.json}"
if [ "${RUN_WORKER_DISPATCH:-}" != "1" ] && [ -n "${WORKER_ROLE:-}" ]; then
  ROLE_CHAIN="$(node -e '
    const fs = require("fs");
    const [file, role] = process.argv.slice(1);
    const ROLES = ["task-check", "decomposition", "implementation", "verification", "acceptance", "github", "linear-report"];
    const WORKERS = ["claude", "codex", "antigravity"];
    if (!ROLES.includes(role)) { process.stdout.write(""); process.exit(0); }
    try {
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      const raw = Array.isArray(cfg[role]) ? cfg[role] : [cfg[role]];
      process.stdout.write(raw.filter(w => WORKERS.includes(w)).join(" "));
    } catch (e) { process.stdout.write(""); }
  ' "$WORKER_ROLES_FILE" "$WORKER_ROLE" 2>/dev/null || echo '')"
  if [ -n "$ROLE_CHAIN" ] && [[ " $ROLE_CHAIN " != *" codex "* ]]; then
    echo "WORKER_ROLE=$WORKER_ROLE chain '[$ROLE_CHAIN]' does not include codex, delegating to Claude" >&2
    exit "$WORKER_NONRESPONSE_EXIT"
  fi
fi

# --- Codex disable flag (SOT-1333) ---
# `ANTIGRAVITY_DISABLED` と対称な個別フラグ。Codex CLI が使えない期間、`CODEX_DISABLED` を真値にすると
# Codex を起動せず非応答コード75で即終了し、CLAUDE.md「Worker Non-Response Fallback Policy」で
# Claude フォールバックに委譲される。真値は 1/true/yes/on（大文字小文字無視）。未設定や他の値は従来動作。
case "$(printf '%s' "${CODEX_DISABLED:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on)
    echo "CODEX_DISABLED: Codex CLI disabled by env flag, delegating to Claude" >&2
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
  # SOT-1446: self-heal a cooldown scheduled absurdly far out (misparsed/far-future reset). No
  # cooldown may keep a worker idle longer than MAX_COOLDOWN_SECONDS (default 18000s=5h); if the
  # stored resumeAt is beyond that ceiling, treat it as stale, clear it, and resume Codex now.
  MAX_COOLDOWN_SECONDS="${MAX_COOLDOWN_SECONDS:-18000}"
  if [ "$RESUME_AT" -gt 0 ] && [ "$((RESUME_AT - NOW_EPOCH))" -gt "$MAX_COOLDOWN_SECONDS" ]; then
    echo "CODEX_COOLDOWN_CAPPED: resumeAt $RESUME_AT is >${MAX_COOLDOWN_SECONDS}s out (now $NOW_EPOCH), clearing stale cooldown and resuming Codex" >&2
    rm -f "$CODEX_COOLDOWN_FILE"
  elif [ "$RESUME_AT" -gt 0 ] && [ "$NOW_EPOCH" -lt "$RESUME_AT" ]; then
    echo "CODEX_COOLDOWN_ACTIVE: codex usage limit until epoch $RESUME_AT (now $NOW_EPOCH), delegating to Claude" >&2
    exit "$WORKER_NONRESPONSE_EXIT"
  else
    echo "Codex cooldown expired (now $NOW_EPOCH >= resumeAt $RESUME_AT), clearing and resuming Codex" >&2
    rm -f "$CODEX_COOLDOWN_FILE"
  fi
fi

# --- Codex auth-unhealthy pre-run check (SOT-1441 / P1) ---
# A CHRONIC auth failure (distinct from a transient usage-limit cooldown) marks Codex auth-unhealthy
# for a short TTL. While the marker is fresh, skip invoking the CLI (which would just re-hit the same
# auth error) and delegate to Claude. Once the TTL expires we clear it and retry.
CODEX_AUTH_UNHEALTHY_FILE="$CONTROL_PLANE_DIR/docs/ai/auto_logs/codex.auth_unhealthy.json"
if [ -f "$CODEX_AUTH_UNHEALTHY_FILE" ]; then
  NOW_EPOCH="$(date +%s)"
  EXPIRES_AT="$(node -e "try{const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(Number(d.expiresAtEpoch)||0));}catch(e){process.stdout.write('0');}" "$CODEX_AUTH_UNHEALTHY_FILE" 2>/dev/null || echo 0)"
  if [ "$EXPIRES_AT" -gt 0 ] && [ "$NOW_EPOCH" -lt "$EXPIRES_AT" ]; then
    echo "CODEX_AUTH_UNHEALTHY: chronic auth failure marker active until epoch $EXPIRES_AT (now $NOW_EPOCH), delegating to Claude" >&2
    exit "$WORKER_NONRESPONSE_EXIT"
  fi
  rm -f "$CODEX_AUTH_UNHEALTHY_FILE"
fi

if [ -n "${TARGET_REPO:-}" ]; then
  echo "Target repository: $TARGET_REPO"
  cd "$TARGET_REPO"
fi

# --- Handoff context (SOT-1459) ---
# On a mid-processing handoff, the dispatcher (run_worker.sh) points WORKER_HANDOFF_REPORT at the
# previous worker's partial report so Codex continues its work instead of restarting from scratch.
PROMPT_CONTENT="$(cat "$PROMPT_FILE")"
if [ -n "${WORKER_HANDOFF_REPORT:-}" ] && [ -s "${WORKER_HANDOFF_REPORT:-/nonexistent}" ]; then
  PROMPT_CONTENT="## Handoff from previous worker (${WORKER_HANDOFF_FROM:-unknown})

The previous worker could not finish (non-response / usage limit). Continue its work — do NOT restart
from scratch. Its partial report follows; pick up where it left off and produce the final report.

<<<PREVIOUS_WORKER_REPORT
$(cat "$WORKER_HANDOFF_REPORT")
PREVIOUS_WORKER_REPORT

---

$PROMPT_CONTENT"
fi

# Capture stderr as well as stdout: Codex prints the usage-limit notice
# ("You've hit your usage limit ... try again at <date>") to stderr, which the
# usage-limit detection below needs to see.
#
# Same-AI session reuse (SOT-1459): if this run already created a Codex session, resume the most
# recent one (`exec resume --last`) so consecutive Codex roles share a warm prompt cache. Disable with
# WORKER_SESSION_REUSE=0. If resume fails to produce a valid report (and it is not a usage limit), fall
# back once to a fresh session so a stale/broken session can never wedge the worker.
run_codex_cli() {
  if [ "$1" = "resume" ]; then
    timeout "${WORKER_TIMEOUT}s" codex --sandbox danger-full-access exec resume --last "$PROMPT_CONTENT" 2>&1 | tee "$REPORT_FILE"
  else
    timeout "${WORKER_TIMEOUT}s" codex --sandbox danger-full-access exec "$PROMPT_CONTENT" 2>&1 | tee "$REPORT_FILE"
  fi
  return "${PIPESTATUS[0]}"
}

_REUSE_ENABLED=1
case "$(printf '%s' "${WORKER_SESSION_REUSE:-1}" | tr '[:upper:]' '[:lower:]')" in
  0|false|no|off) _REUSE_ENABLED=0 ;;
esac

set +e
if [ "$_REUSE_ENABLED" -eq 1 ] && [ -f "$CODEX_SESSION_MARKER" ]; then
  echo "CODEX_SESSION_REUSE: resuming most recent Codex session (warm cache)" >&2
  run_codex_cli resume
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -ne 0 ] \
    && ! grep -q "## Next Action" "$REPORT_FILE" 2>/dev/null \
    && ! grep -qi "usage limit" "$REPORT_FILE" 2>/dev/null; then
    echo "CODEX_RESUME_FALLBACK: resume --last failed (exit $EXIT_CODE); retrying with a fresh session" >&2
    run_codex_cli fresh
    EXIT_CODE=$?
  fi
else
  run_codex_cli fresh
  EXIT_CODE=$?
fi
set -e

# Record that this run now has a Codex session so the next same-run Codex call can resume it.
if [ "$EXIT_CODE" -eq 0 ]; then
  mkdir -p "$(dirname "$CODEX_SESSION_MARKER")" 2>/dev/null || true
  : > "$CODEX_SESSION_MARKER" 2>/dev/null || true
fi

# --- Codex usage-limit detection (set cooldown, delegate to Claude) ---
# Codex prints "You've hit your usage limit ... try again at <date>" and exits
# non-zero. Detect it, persist the reset time so future runs can auto-resume, and
# exit with the non-response code so the orchestrator falls back to Claude now.
if [ -f "$REPORT_FILE" ] \
  && grep -qi "usage limit" "$REPORT_FILE" \
  && grep -qi "try again at" "$REPORT_FILE"; then
  mkdir -p "$(dirname "$CODEX_COOLDOWN_FILE")"
  RESUME_EPOCH="$( run_cli parse-usage-limit-epoch < "$REPORT_FILE" 2>/dev/null || true)"
  if [ -n "$RESUME_EPOCH" ]; then
    node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({resumeAtEpoch:Number(process.argv[2]),detectedAt:new Date().toISOString(),reason:'codex_usage_limit'},null,2));" "$CODEX_COOLDOWN_FILE" "$RESUME_EPOCH"
    echo "CODEX_USAGE_LIMIT: cooldown set until epoch $RESUME_EPOCH, delegating to Claude" >&2
    run_cli notify-cooldown codex >/dev/null 2>&1 || true
  else
    echo "CODEX_USAGE_LIMIT: detected but reset time unparseable, notifying Discord without cooldown" >&2
    run_cli notify-usage-limit-unknown codex >/dev/null 2>&1 || true
  fi
  exit "$WORKER_NONRESPONSE_EXIT"
fi

# --- Codex chronic auth-failure detection (SOT-1441 / P1) ---
# On a non-zero exit that is NOT a usage-limit (handled above), classify the report. A chronic auth
# failure marks Codex auth-unhealthy (short TTL) so subsequent runs skip fast, with a separated alert
# (chronic vs transient). Best-effort; never blocks the fallback exit below.
if [ "$EXIT_CODE" -ne 0 ] && [ -f "$REPORT_FILE" ]; then
  run_cli worker-health-record codex "$EXIT_CODE" < "$REPORT_FILE" >/dev/null 2>&1 || true
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

# SOT-1349: post the worker report to Discord (best-effort; never affects worker success)
run_cli notify-worker-report codex "$REPORT_FILE" >/dev/null 2>&1 || true
