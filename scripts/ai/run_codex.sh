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
# Claude が全作業を担当する運用モード。`ALL_CLAUDE_MODE` を真値にすると Antigravity/Codex 両ワーカーを
# 一括無効化し、実装も検証も Claude Code が CLAUDE.md「Worker Non-Response Fallback Policy」で代行する。
# このマスターフラグは cooldown pre-check より先に評価される短絡。真値は 1/true/yes/on（大小無視）。
case "$(printf '%s' "${ALL_CLAUDE_MODE:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on)
    echo "ALL_CLAUDE_MODE: all worker delegation disabled by env flag, delegating to Claude" >&2
    exit "$WORKER_NONRESPONSE_EXIT"
    ;;
esac

# --- Worker-mode config selector (SOT-1333 / SOT-1334) ---
# `WORKER_MODE` を設定から選ぶと、Codexのみ/Claudeのみ/Antigravityのみの運用モードを切り替えられる。
# 値（大小無視, 未設定/その他は all 扱い）:
#   all              : Antigravity・Codex 両方を起動（既定）
#   claude-only      : 両ワーカーを起動しない（Claude が全担当, ALL_CLAUDE_MODE と等価）
#   codex-only       : Codexのみ起動（Antigravity は呼び出さない）
#   antigravity-only : Antigravityのみ起動（Codex は呼び出さない）
# このスクリプト（Codex側）は claude-only / antigravity-only のとき非応答コード75で即終了し、Codex CLI を
# 一切起動しない。評価は ALL_CLAUDE_MODE の直後・CODEX_DISABLED / cooldown より先。
case "$(printf '%s' "${WORKER_MODE:-}" | tr '[:upper:]' '[:lower:]')" in
  claude-only|antigravity-only)
    echo "WORKER_MODE=${WORKER_MODE}: Codex disabled by worker-mode config, delegating to Claude" >&2
    exit "$WORKER_NONRESPONSE_EXIT"
    ;;
esac

# --- Per-role worker assignment (SOT-1459) ---
# 役割ごとにワーカーを割り当てる編集可能ファイル `config/worker_roles.json`（.env ではない）を参照する。
# 呼び出し側が `WORKER_ROLE=<task-check|verification|...>` を渡したとき、その役割の割当ワーカーが codex
# でなければ（= claude / antigravity に振られていれば）Codex を起動せず非応答コード 75 で委譲する。
# WORKER_ROLE 未設定・不明ロール・設定ファイル不備のときは何もせず従来動作（後方互換・フェイルオープン）。
# 評価は WORKER_MODE の後・CODEX_DISABLED / cooldown の前。グローバル env スイッチが常に優先される。
WORKER_ROLES_FILE="${WORKER_ROLES_FILE:-$CONTROL_PLANE_DIR/config/worker_roles.json}"
if [ -n "${WORKER_ROLE:-}" ]; then
  ROLE_WORKER="$(node -e '
    const fs = require("fs");
    const [file, role] = process.argv.slice(1);
    const ROLES = ["task-check", "decomposition", "implementation", "verification", "acceptance"];
    const WORKERS = ["claude", "codex", "antigravity"];
    if (!ROLES.includes(role)) { process.stdout.write(""); process.exit(0); }
    try {
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      const w = cfg[role];
      process.stdout.write(WORKERS.includes(w) ? String(w) : "");
    } catch (e) { process.stdout.write(""); }
  ' "$WORKER_ROLES_FILE" "$WORKER_ROLE" 2>/dev/null || echo '')"
  if [ -n "$ROLE_WORKER" ] && [ "$ROLE_WORKER" != "codex" ]; then
    echo "WORKER_ROLE=$WORKER_ROLE assigned to '$ROLE_WORKER' (not codex) by config/worker_roles.json, delegating to Claude" >&2
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

# --- Codex chronic auth-failure detection (SOT-1441 / P1) ---
# On a non-zero exit that is NOT a usage-limit (handled above), classify the report. A chronic auth
# failure marks Codex auth-unhealthy (short TTL) so subsequent runs skip fast, with a separated alert
# (chronic vs transient). Best-effort; never blocks the fallback exit below.
if [ "$EXIT_CODE" -ne 0 ] && [ -f "$REPORT_FILE" ]; then
  (cd "$CONTROL_PLANE_DIR" && npx tsx src/runner-cli.ts worker-health-record codex "$EXIT_CODE" < "$REPORT_FILE") >/dev/null 2>&1 || true
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
(cd "$CONTROL_PLANE_DIR" && npx tsx src/runner-cli.ts notify-worker-report codex "$REPORT_FILE") >/dev/null 2>&1 || true
