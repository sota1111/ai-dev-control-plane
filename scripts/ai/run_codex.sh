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

# SOT-1615: surface the model in the banner so run_auto.sh's tag filter can render `[codex-<model>]`
# in the log instead of a bare `[codex]`. Only when a model pin is set (CODEX_MODEL via run_worker.sh);
# absent → no suffix → the filter keeps the historical `[codex]` tag (backward compatible).
echo "== Codex CLI: debugging worker ==${CODEX_MODEL:+ model=${CODEX_MODEL}}"

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
WORKER_POLICY_BLOCKED_EXIT=76

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

PROMPT_CONTENT="$(cat "$PROMPT_FILE")"

# --- Harness spec injection (SOT-1614): give Codex the SAME directives as Claude ---
# The Claude worker runs `claude -p` from the control-plane repo root and therefore AUTO-LOADS CLAUDE.md
# (the full harness spec: role definitions, quality gates, GitHub/Linear/safety policy) as project
# context. `codex exec` has no such auto-load, and — because run_codex.sh cd's into TARGET_REPO above —
# even Codex's native AGENTS.md project-doc (which is also 32KB-capped, below CLAUDE.md's size) would not
# be read from the control-plane repo. So we inject CLAUDE.md explicitly into Codex's prompt here, cwd-
# independently, mirroring the constraint preamble the Claude worker prepends in run_claude.sh (SOT-1459):
# a `solo` dispatch owns the whole lifecycle for one issue; every other role is a single-role worker.
# This makes Codex a true peer that receives Claude's directive set. Default on; disable with
# CODEX_HARNESS_SPEC=0 (e.g. a pure target-repo task where the control-plane spec adds only token cost).
HARNESS_SPEC_ENABLED=1
case "$(printf '%s' "${CODEX_HARNESS_SPEC:-1}" | tr '[:upper:]' '[:lower:]')" in
  0|false|no|off) HARNESS_SPEC_ENABLED=0 ;;
esac
CLAUDE_MD_FILE="$CONTROL_PLANE_DIR/CLAUDE.md"
# Per-issue pipeline context path (run_auto.sh exports PIPELINE_CONTEXT_FILE, absolute, so concurrent
# drains of different projects never share one context.md). Fall back to the shared file when unset.
CTX_FILE="${PIPELINE_CONTEXT_FILE:-docs/ai/pipeline/context.md}"
if [ "$HARNESS_SPEC_ENABLED" -eq 1 ] && [ -f "$CLAUDE_MD_FILE" ]; then
  if [ "${WORKER_ROLE:-}" = "solo" ]; then
    CODEX_PREAMBLE="# YOU ARE THE SOLO WORKER — ONE AI, THE WHOLE LIFECYCLE FOR ONE ISSUE

You were dispatched by scripts/ai/run_worker.sh in SOLO MODE to run the ENTIRE lifecycle for the single
target issue in $CTX_FILE, yourself, in this one session — with NO per-role script
handoff. Follow CLAUDE.md's role specs, quality gates, GitHub policy, and Linear policy, but you perform
every step directly: task-check (incl. 分解判断) → implementation → verification → acceptance → github
(branch/PR/merge) → linear-report. Hard rules:
- Do NOT run scripts/ai/run_auto.sh, scripts/ai/run_worker.sh, scripts/ai/scheduler.sh, the webhook
  server, or the runner queue/drain. Do NOT spawn or trigger any other run.
- In-container background and long-lived commands are allowed. Track their PID/log/output and wait for
  required results before reporting completion. Do not end with waiting prose; keep this CLI session
  alive with repeated bounded polls and always emit the report contract. On a retry, inspect existing
  PIDs/outputs and never launch a duplicate writer for the same result."
  else
    CODEX_PREAMBLE="# YOU ARE A CONSTRAINED WORKER — NOT THE ORCHESTRATOR

You were dispatched by scripts/ai/run_worker.sh to perform EXACTLY ONE role for the single target issue
described below / in $CTX_FILE. CLAUDE.md in this repo describes the ORCHESTRATOR;
IGNORE its instructions about decomposing or driving the pipeline. Hard rules:
- Do ONLY the one role task in this prompt. Then write your report and stop.
- Do NOT run scripts/ai/run_auto.sh, scripts/ai/run_worker.sh, scripts/ai/scheduler.sh, the webhook
  server, or the runner queue/drain. Do NOT spawn or trigger any other run.
- Do NOT run anything in the background or start long-lived processes."
  fi
  PROMPT_CONTENT="$CODEX_PREAMBLE

---

# CONTROL-PLANE HARNESS SPECIFICATION (CLAUDE.md)

The following is CLAUDE.md — the same harness spec the Claude worker auto-loads. Follow it together with
the constraints above and your role instruction at the end.

$(cat "$CLAUDE_MD_FILE")

---

# YOUR ROLE INSTRUCTION

$PROMPT_CONTENT"
fi

# --- Handoff context (SOT-1459) ---
# On a mid-processing handoff, the dispatcher (run_worker.sh) points WORKER_HANDOFF_REPORT at the
# previous worker's partial report so Codex continues its work instead of restarting from scratch.
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
# SOT-1583: a per-issue directive `workers: <role>=codex:<model>` sets CODEX_MODEL (via run_worker.sh).
# When set, pass it to a FRESH `codex exec` as `-m <model>` (Codex's `-p` is a profile, not the model).
# A resumed session (`exec resume --last`) already inherits the model chosen when it was created, so the
# flag is applied to fresh sessions only. Unset → no `-m` flag → Codex's default model (backward compat).
# Friendly model aliases for the Codex worker. A Linear directive can select a Codex model by a short
# human name (e.g. `workers: implementation=codex:sol`) instead of typing the full `codex exec -m` id.
# Resolve the alias to the canonical model id here; matching is case-insensitive and unknown values pass
# through verbatim, so any raw `-m` id (`codex:gpt-5.5`, etc.) still works. Add new aliases to this case.
#   sol / "gpt-5.6 sol" / gpt-5.6-sol  → GPT-5.6 Sol (canonical id: gpt-5.6-sol)
resolve_codex_model_alias() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    sol|"gpt-5.6 sol"|gpt-5.6-sol|sol-max) echo "gpt-5.6-sol" ;;
    *) printf '%s' "$1" ;;
  esac
}

CODEX_MODEL_ARGS=()
CODEX_REASONING_ARGS=()
if [ -n "${CODEX_MODEL:-}" ]; then
  CODEX_RESOLVED_MODEL="$(resolve_codex_model_alias "$CODEX_MODEL")"
  CODEX_MODEL_ARGS=(-m "$CODEX_RESOLVED_MODEL")
  if [ "$CODEX_RESOLVED_MODEL" != "$CODEX_MODEL" ]; then
    echo "run_codex.sh: model alias '$CODEX_MODEL' → '$CODEX_RESOLVED_MODEL' (codex exec -m)" >&2
  else
    echo "run_codex.sh: using model '$CODEX_MODEL' (codex exec -m)" >&2
  fi
fi
if [ -n "${CODEX_REASONING_EFFORT:-}" ]; then
  CODEX_REASONING_ARGS=(-c "model_reasoning_effort=\"${CODEX_REASONING_EFFORT}\"")
  echo "run_codex.sh: reasoning effort '${CODEX_REASONING_EFFORT}'" >&2
fi

run_codex_cli() {
  local timeout_prefix=(timeout "${WORKER_TIMEOUT}s")
  [ "${WORKER_ROLE:-}" = "solo" ] && timeout_prefix=()
  if [ "$1" = "resume" ]; then
    "${timeout_prefix[@]}" codex --sandbox danger-full-access exec resume --last "$PROMPT_CONTENT" 2>&1 | tee "$REPORT_FILE"
  else
    "${timeout_prefix[@]}" codex --sandbox danger-full-access exec "${CODEX_MODEL_ARGS[@]}" "${CODEX_REASONING_ARGS[@]}" "$PROMPT_CONTENT" 2>&1 | tee "$REPORT_FILE"
  fi
  return "${PIPESTATUS[0]}"
}

_REUSE_ENABLED=1
case "$(printf '%s' "${WORKER_SESSION_REUSE:-1}" | tr '[:upper:]' '[:lower:]')" in
  0|false|no|off) _REUSE_ENABLED=0 ;;
esac

set +e
if [ "$_REUSE_ENABLED" -eq 1 ] && [ -z "${CODEX_MODEL:-}" ] && [ -f "$CODEX_SESSION_MARKER" ]; then
  echo "CODEX_SESSION_REUSE: resuming most recent Codex session (warm cache)" >&2
  run_codex_cli resume
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -ne 0 ] \
    && ! grep -q "## Next Action" "$REPORT_FILE" 2>/dev/null \
    && ! grep -qi "usage limit" "$REPORT_FILE" 2>/dev/null \
    && ! grep -Eqi "flagged for possible cybersecurity risk|Trusted Access for Cyber" "$REPORT_FILE" 2>/dev/null; then
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

# A safety-policy refusal is deterministic for the same content. It is neither a usage limit nor a
# transient crash, so retrying the same solo worker wastes quota and repeats the refusal. Surface a
# dedicated exit that the dispatcher/run_auto path converts into a Blocked human-wait state.
if [ "$EXIT_CODE" -ne 0 ] \
  && [ -f "$REPORT_FILE" ] \
  && grep -Eqi "flagged for possible cybersecurity risk|Trusted Access for Cyber" "$REPORT_FILE"; then
  echo "WORKER_POLICY_BLOCKED: codex safety policy refusal; automatic retry disabled" >&2
  exit "$WORKER_POLICY_BLOCKED_EXIT"
fi

# --- Codex usage-limit detection (set cooldown, delegate to Claude) ---
# Codex prints "You've hit your usage limit ... try again at <date>" and exits
# non-zero. Detect it, persist the reset time so future runs can auto-resume, and
# exit with the non-response code so the orchestrator falls back to Claude now.
if [ "$EXIT_CODE" -ne 0 ] \
  && [ -f "$REPORT_FILE" ] \
  && grep -Eqi "you('|’)ve hit your usage limit" "$REPORT_FILE" \
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
