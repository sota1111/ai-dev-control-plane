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

PROMPT_FILE="$(lane_path "$CONTROL_PLANE_DIR/prompts/antigravity/implement.md")"
REPORT_FILE="$(lane_path "$CONTROL_PLANE_DIR/docs/ai/50_worker_antigravity_report.md")"
# Cooldown is account-global (worker usage limit is shared across lanes): NOT lane-suffixed.
ANTIGRAVITY_COOLDOWN_FILE="$CONTROL_PLANE_DIR/docs/ai/auto_logs/antigravity.cooldown.json"
# Same-AI session reuse marker (SOT-1459): present once this run has created an Antigravity
# conversation, so a later same-run invocation continues it (warm cache). run_auto.sh clears it per run.
ANTIGRAVITY_SESSION_MARKER="$(lane_path "$CONTROL_PLANE_DIR/docs/ai/auto_logs/antigravity_worker_session.marker")"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

# SOT-1615: surface the model in the banner so run_auto.sh's tag filter can render `[agy-<model>]` in
# the log instead of a bare `[agy]`. Only when a model pin is set (AGY_MODEL via run_worker.sh); absent
# → no suffix → the filter keeps the historical `[agy]` tag (backward compatible).
echo "== Antigravity CLI: implementation worker ==${AGY_MODEL:+ model=${AGY_MODEL}}"

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

# --- Per-role gate (DIRECT invocation only; SOT-1459) ---
# Worker selection is owned by the dispatcher `scripts/ai/run_worker.sh`, which reads the role's
# ordered chain from config/worker_roles.json and sets RUN_WORKER_DISPATCH=1 when it picks a worker.
# Under dispatch we therefore skip this gate. For a DIRECT/legacy call with WORKER_ROLE set, exit 75
# if `antigravity` is not in the role's chain (fail-open on unset/unknown/broken config). Evaluated
# before ANTIGRAVITY_DISABLED (per-worker availability) / cooldown.
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
  if [ -n "$ROLE_CHAIN" ] && [[ " $ROLE_CHAIN " != *" antigravity "* ]]; then
    echo "WORKER_ROLE=$WORKER_ROLE chain '[$ROLE_CHAIN]' does not include antigravity, delegating to Claude" >&2
    exit "$WORKER_NONRESPONSE_EXIT"
  fi
fi

# --- Antigravity disable flag (SOT-957 / SOT-1334) ---
# Google のプラン変更等で Antigravity CLI が使えない期間、`ANTIGRAVITY_DISABLED` を真値にすると Antigravity を
# 起動せず非応答コード 75 で即終了する。これにより CLAUDE.md「Worker Non-Response Fallback Policy」で
# Claude フォールバックに委譲される。真値は 1/true/yes/on（大文字小文字無視）。未設定や他の値は従来動作。
case "$(printf '%s' "${ANTIGRAVITY_DISABLED:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on)
    echo "ANTIGRAVITY_DISABLED: Antigravity CLI disabled by env flag, delegating to Claude" >&2
    exit "$WORKER_NONRESPONSE_EXIT"
    ;;
esac

# --- Antigravity usage-limit cooldown pre-check (auto fallback / auto resume) ---
if [ -f "$ANTIGRAVITY_COOLDOWN_FILE" ]; then
  NOW_EPOCH="$(date +%s)"
  RESUME_AT="$(node -e "try{const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(Number(d.resumeAtEpoch)||0));}catch(e){process.stdout.write('0');}" "$ANTIGRAVITY_COOLDOWN_FILE" 2>/dev/null || echo 0)"
  # SOT-1446: self-heal a cooldown scheduled absurdly far out (misparsed/far-future reset). No
  # cooldown may keep a worker idle longer than MAX_COOLDOWN_SECONDS (default 18000s=5h); if the
  # stored resumeAt is beyond that ceiling, treat it as stale, clear it, and resume Antigravity now.
  MAX_COOLDOWN_SECONDS="${MAX_COOLDOWN_SECONDS:-18000}"
  if [ "$RESUME_AT" -gt 0 ] && [ "$((RESUME_AT - NOW_EPOCH))" -gt "$MAX_COOLDOWN_SECONDS" ]; then
    echo "ANTIGRAVITY_COOLDOWN_CAPPED: resumeAt $RESUME_AT is >${MAX_COOLDOWN_SECONDS}s out (now $NOW_EPOCH), clearing stale cooldown and resuming Antigravity" >&2
    rm -f "$ANTIGRAVITY_COOLDOWN_FILE"
  elif [ "$RESUME_AT" -gt 0 ] && [ "$NOW_EPOCH" -lt "$RESUME_AT" ]; then
    echo "ANTIGRAVITY_COOLDOWN_ACTIVE: antigravity usage limit until epoch $RESUME_AT (now $NOW_EPOCH), delegating to Claude" >&2
    exit "$WORKER_NONRESPONSE_EXIT"
  else
    echo "Antigravity cooldown expired (now $NOW_EPOCH >= resumeAt $RESUME_AT), clearing and resuming Antigravity" >&2
    rm -f "$ANTIGRAVITY_COOLDOWN_FILE"
  fi
fi

# --- Antigravity auth-unhealthy pre-run check (SOT-1441 / P1) ---
# A CHRONIC auth failure (distinct from a transient usage-limit cooldown) marks Antigravity
# auth-unhealthy for a short TTL. While the marker is fresh, skip invoking the CLI (which would just
# re-hit the same auth error) and delegate to Claude. Once the TTL expires we clear it and retry.
ANTIGRAVITY_AUTH_UNHEALTHY_FILE="$CONTROL_PLANE_DIR/docs/ai/auto_logs/antigravity.auth_unhealthy.json"
if [ -f "$ANTIGRAVITY_AUTH_UNHEALTHY_FILE" ]; then
  # SOT-1548: decide via the tested readAuthUnhealthy() pure logic (the same module that writes the
  # marker) instead of re-parsing it here with an inline `node -e`. This closes the path/parsing/expiry
  # drift between reader and writer that let a fresh marker slip through and pay the ~40s auth probe
  # (SOT-1533). `auth-unhealthy-status` exits 0 when the marker is FRESH (short-circuit) / 3 otherwise.
  # Fail-open: a runner-cli error (non-0/3) is treated as "not fresh" so we never wedge on a broken CLI.
  if AUTH_STATUS="$(run_cli auth-unhealthy-status antigravity 2>/dev/null)"; then
    echo "ANTIGRAVITY_AUTH_UNHEALTHY: chronic auth failure marker fresh ($AUTH_STATUS), skipping agy launch and delegating to Claude" >&2
    exit "$WORKER_NONRESPONSE_EXIT"
  fi
  # Not fresh (expired / missing / malformed): clear the stale marker and retry agy as before.
  rm -f "$ANTIGRAVITY_AUTH_UNHEALTHY_FILE"
fi

# Antigravity CLI (agy) flags (SOT-1334):
#   -p / --print                   : run a single prompt non-interactively and print the response
#   --add-dir DIR                  : add the target repo to the workspace (= old gemini --include-directories)
#   --dangerously-skip-permissions : auto-approve all tool permissions (= old gemini --yolo)
#   --print-timeout DURATION       : print-mode wait timeout (default 5m). Aligned to WORKER_TIMEOUT so
#                                    long implementations are not cut off at agy's internal 5m default.
# --- Handoff context (SOT-1459) ---
# On a mid-processing handoff, the dispatcher (run_worker.sh) points WORKER_HANDOFF_REPORT at the
# previous worker's partial report so Antigravity continues its work instead of restarting.
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

[ -n "${TARGET_REPO:-}" ] && echo "Target repository: $TARGET_REPO"

# Base agy args (shared by fresh + resume). --add-dir only when a target repo is set.
AGY_ARGS=(-p "$PROMPT_CONTENT" --dangerously-skip-permissions --print-timeout "${WORKER_TIMEOUT}s")
[ -n "${TARGET_REPO:-}" ] && AGY_ARGS+=(--add-dir "$TARGET_REPO")
# SOT-1583: a per-issue directive `workers: <role>=agy:<model>` sets AGY_MODEL (via run_worker.sh); pass
# it to agy as `--model "<model>"`. Model names may contain spaces/parens (e.g. "Gemini 3.5 Flash
# (High)"), so keep it quoted. Unset → no --model flag → agy's default model (backward compatible).
if [ -n "${AGY_MODEL:-}" ]; then
  AGY_ARGS+=(--model "$AGY_MODEL")
  echo "run_antigravity.sh: using model '$AGY_MODEL' (agy --model)" >&2
fi

# Same-AI session reuse (SOT-1459): if this run already created an Antigravity conversation, continue
# the most recent one (`--continue`) so consecutive Antigravity roles share a warm cache. Disable with
# WORKER_SESSION_REUSE=0. If resume fails to produce a valid report (and it is not a usage limit), fall
# back once to a fresh conversation so a stale/broken conversation can never wedge the worker.
run_agy_cli() {
  if [ "$1" = "resume" ]; then
    timeout "${WORKER_TIMEOUT}s" agy "${AGY_ARGS[@]}" --continue 2>&1 | tee "$REPORT_FILE"
  else
    timeout "${WORKER_TIMEOUT}s" agy "${AGY_ARGS[@]}" 2>&1 | tee "$REPORT_FILE"
  fi
  return "${PIPESTATUS[0]}"
}

_REUSE_ENABLED=1
case "$(printf '%s' "${WORKER_SESSION_REUSE:-1}" | tr '[:upper:]' '[:lower:]')" in
  0|false|no|off) _REUSE_ENABLED=0 ;;
esac

set +e
if [ "$_REUSE_ENABLED" -eq 1 ] && [ -f "$ANTIGRAVITY_SESSION_MARKER" ]; then
  echo "ANTIGRAVITY_SESSION_REUSE: continuing most recent Antigravity conversation (warm cache)" >&2
  run_agy_cli resume
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -ne 0 ] \
    && ! grep -q "## Next Action" "$REPORT_FILE" 2>/dev/null \
    && ! grep -Ei "usage limit|quota exceeded|resource exhausted|rate limit|RESOURCE_EXHAUSTED" "$REPORT_FILE" 2>/dev/null; then
    echo "ANTIGRAVITY_RESUME_FALLBACK: --continue failed (exit $EXIT_CODE); retrying with a fresh conversation" >&2
    run_agy_cli fresh
    EXIT_CODE=$?
  fi
else
  run_agy_cli fresh
  EXIT_CODE=$?
fi
set -e

# Record that this run now has an Antigravity conversation so the next same-run call can continue it.
if [ "$EXIT_CODE" -eq 0 ]; then
  mkdir -p "$(dirname "$ANTIGRAVITY_SESSION_MARKER")" 2>/dev/null || true
  : > "$ANTIGRAVITY_SESSION_MARKER" 2>/dev/null || true
fi

# --- Antigravity usage-limit detection (set cooldown, delegate to Claude) ---
# Only treat as usage-limit when the run actually FAILED (non-zero exit). A real
# Antigravity quota/limit aborts the run, so EXIT_CODE != 0. Gating on this avoids
# false positives when a successful run's report merely mentions these keywords
# (e.g. while implementing usage-limit features, the report contains "usage limit").
if [ "$EXIT_CODE" -ne 0 ] \
  && [ -f "$REPORT_FILE" ] \
  && grep -Ei "usage limit|quota exceeded|resource exhausted|rate limit|RESOURCE_EXHAUSTED|try again at|resets at|exhausted your daily quota|daily quota|429|too many requests|quota exceeded for quota metric|please retry in" "$REPORT_FILE" > /dev/null; then
  mkdir -p "$(dirname "$ANTIGRAVITY_COOLDOWN_FILE")"
  RESUME_EPOCH="$( run_cli parse-usage-limit-epoch < "$REPORT_FILE" 2>/dev/null || true)"
  if [ -n "$RESUME_EPOCH" ]; then
    node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({resumeAtEpoch:Number(process.argv[2]),detectedAt:new Date().toISOString(),reason:'antigravity_usage_limit'},null,2));" "$ANTIGRAVITY_COOLDOWN_FILE" "$RESUME_EPOCH"
    echo "ANTIGRAVITY_USAGE_LIMIT: cooldown set until epoch $RESUME_EPOCH, delegating to Claude" >&2
    run_cli notify-cooldown antigravity >/dev/null 2>&1 || true
  else
    echo "ANTIGRAVITY_USAGE_LIMIT: detected but reset time unparseable, notifying Discord without cooldown" >&2
    run_cli notify-usage-limit-unknown antigravity >/dev/null 2>&1 || true
  fi
  exit "$WORKER_NONRESPONSE_EXIT"
fi

# --- Antigravity chronic auth-failure detection (SOT-1441 / P1) ---
# On a non-zero exit that is NOT a usage-limit (handled above), classify the report. A chronic auth
# failure marks Antigravity auth-unhealthy (short TTL) so subsequent runs skip fast, with a separated
# alert (chronic vs transient). Best-effort; never blocks the fallback exit below.
if [ "$EXIT_CODE" -ne 0 ] && [ -f "$REPORT_FILE" ]; then
  run_cli worker-health-record antigravity "$EXIT_CODE" < "$REPORT_FILE" >/dev/null 2>&1 || true
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
  echo "WORKER_NONRESPONSE: antigravity ($REASON)" >&2
  exit "$WORKER_NONRESPONSE_EXIT"
fi

# SOT-1349: post the worker report to Discord (best-effort; never affects worker success)
run_cli notify-worker-report antigravity "$REPORT_FILE" >/dev/null 2>&1 || true
