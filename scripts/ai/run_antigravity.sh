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

PROMPT_FILE="$(lane_path "$CONTROL_PLANE_DIR/prompts/antigravity/implement.md")"
REPORT_FILE="$(lane_path "$CONTROL_PLANE_DIR/docs/ai/50_worker_antigravity_report.md")"
# Cooldown is account-global (worker usage limit is shared across lanes): NOT lane-suffixed.
ANTIGRAVITY_COOLDOWN_FILE="$CONTROL_PLANE_DIR/docs/ai/auto_logs/antigravity.cooldown.json"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

echo "== Antigravity CLI: implementation worker =="

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

# --- All-Claude mode master flag (SOT-993) ---
# Claude が全作業を担当する運用モード。`ALL_CLAUDE_MODE` を真値にすると Antigravity/Codex 両ワーカーを
# 一括無効化し、実装も検証も Claude Code が CLAUDE.md「Worker Non-Response Fallback Policy」で代行する。
# このマスターフラグは ANTIGRAVITY_DISABLED や cooldown より先に評価される短絡。真値は 1/true/yes/on（大小無視）。
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
# このスクリプト（Antigravity側）は claude-only / codex-only のとき非応答コード75で即終了し、Antigravity CLI を
# 一切起動しない。評価は ALL_CLAUDE_MODE の直後・ANTIGRAVITY_DISABLED / cooldown より先。
case "$(printf '%s' "${WORKER_MODE:-}" | tr '[:upper:]' '[:lower:]')" in
  claude-only|codex-only)
    echo "WORKER_MODE=${WORKER_MODE}: Antigravity disabled by worker-mode config, delegating to Claude" >&2
    exit "$WORKER_NONRESPONSE_EXIT"
    ;;
esac

# --- Per-role worker assignment (SOT-1459) ---
# 役割ごとにワーカーを割り当てる編集可能ファイル `config/worker_roles.json`（.env ではない）を参照する。
# 呼び出し側が `WORKER_ROLE=<implementation|...>` を渡したとき、その役割の割当ワーカーが antigravity
# でなければ（= claude / codex に振られていれば）Antigravity を起動せず非応答コード 75 で委譲する。
# WORKER_ROLE 未設定・不明ロール・設定ファイル不備のときは何もせず従来動作（後方互換・フェイルオープン）。
# 評価は WORKER_MODE の後・ANTIGRAVITY_DISABLED / cooldown の前。グローバル env スイッチが常に優先される。
WORKER_ROLES_FILE="${WORKER_ROLES_FILE:-$CONTROL_PLANE_DIR/config/worker_roles.json}"
if [ -n "${WORKER_ROLE:-}" ]; then
  ROLE_WORKER="$(node -e '
    const fs = require("fs");
    const [file, role] = process.argv.slice(1);
    const ROLES = ["task-check", "decomposition", "implementation", "verification", "acceptance", "github", "linear-report"];
    const WORKERS = ["claude", "codex", "antigravity"];
    if (!ROLES.includes(role)) { process.stdout.write(""); process.exit(0); }
    try {
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      const w = cfg[role];
      process.stdout.write(WORKERS.includes(w) ? String(w) : "");
    } catch (e) { process.stdout.write(""); }
  ' "$WORKER_ROLES_FILE" "$WORKER_ROLE" 2>/dev/null || echo '')"
  if [ -n "$ROLE_WORKER" ] && [ "$ROLE_WORKER" != "antigravity" ]; then
    echo "WORKER_ROLE=$WORKER_ROLE assigned to '$ROLE_WORKER' (not antigravity) by config/worker_roles.json, delegating to Claude" >&2
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
  NOW_EPOCH="$(date +%s)"
  EXPIRES_AT="$(node -e "try{const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(Number(d.expiresAtEpoch)||0));}catch(e){process.stdout.write('0');}" "$ANTIGRAVITY_AUTH_UNHEALTHY_FILE" 2>/dev/null || echo 0)"
  if [ "$EXPIRES_AT" -gt 0 ] && [ "$NOW_EPOCH" -lt "$EXPIRES_AT" ]; then
    echo "ANTIGRAVITY_AUTH_UNHEALTHY: chronic auth failure marker active until epoch $EXPIRES_AT (now $NOW_EPOCH), delegating to Claude" >&2
    exit "$WORKER_NONRESPONSE_EXIT"
  fi
  rm -f "$ANTIGRAVITY_AUTH_UNHEALTHY_FILE"
fi

# Antigravity CLI (agy) flags (SOT-1334):
#   -p / --print                   : run a single prompt non-interactively and print the response
#   --add-dir DIR                  : add the target repo to the workspace (= old gemini --include-directories)
#   --dangerously-skip-permissions : auto-approve all tool permissions (= old gemini --yolo)
#   --print-timeout DURATION       : print-mode wait timeout (default 5m). Aligned to WORKER_TIMEOUT so
#                                    long implementations are not cut off at agy's internal 5m default.
if [ -n "${TARGET_REPO:-}" ]; then
  echo "Target repository: $TARGET_REPO"
  set +e
  timeout "${WORKER_TIMEOUT}s" agy -p "$(cat "$PROMPT_FILE")" --add-dir "$TARGET_REPO" --dangerously-skip-permissions --print-timeout "${WORKER_TIMEOUT}s" 2>&1 | tee "$REPORT_FILE"
  EXIT_CODE="${PIPESTATUS[0]}"
  set -e
else
  set +e
  timeout "${WORKER_TIMEOUT}s" agy -p "$(cat "$PROMPT_FILE")" --dangerously-skip-permissions --print-timeout "${WORKER_TIMEOUT}s" 2>&1 | tee "$REPORT_FILE"
  EXIT_CODE="${PIPESTATUS[0]}"
  set -e
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
  RESUME_EPOCH="$( (cd "$CONTROL_PLANE_DIR" && npx tsx src/runner-cli.ts parse-usage-limit-epoch < "$REPORT_FILE") 2>/dev/null || true)"
  if [ -n "$RESUME_EPOCH" ]; then
    node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({resumeAtEpoch:Number(process.argv[2]),detectedAt:new Date().toISOString(),reason:'antigravity_usage_limit'},null,2));" "$ANTIGRAVITY_COOLDOWN_FILE" "$RESUME_EPOCH"
    echo "ANTIGRAVITY_USAGE_LIMIT: cooldown set until epoch $RESUME_EPOCH, delegating to Claude" >&2
    (cd "$CONTROL_PLANE_DIR" && npx tsx src/runner-cli.ts notify-cooldown antigravity) >/dev/null 2>&1 || true
  else
    echo "ANTIGRAVITY_USAGE_LIMIT: detected but reset time unparseable, notifying Discord without cooldown" >&2
    (cd "$CONTROL_PLANE_DIR" && npx tsx src/runner-cli.ts notify-usage-limit-unknown antigravity) >/dev/null 2>&1 || true
  fi
  exit "$WORKER_NONRESPONSE_EXIT"
fi

# --- Antigravity chronic auth-failure detection (SOT-1441 / P1) ---
# On a non-zero exit that is NOT a usage-limit (handled above), classify the report. A chronic auth
# failure marks Antigravity auth-unhealthy (short TTL) so subsequent runs skip fast, with a separated
# alert (chronic vs transient). Best-effort; never blocks the fallback exit below.
if [ "$EXIT_CODE" -ne 0 ] && [ -f "$REPORT_FILE" ]; then
  (cd "$CONTROL_PLANE_DIR" && npx tsx src/runner-cli.ts worker-health-record antigravity "$EXIT_CODE" < "$REPORT_FILE") >/dev/null 2>&1 || true
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
(cd "$CONTROL_PLANE_DIR" && npx tsx src/runner-cli.ts notify-worker-report antigravity "$REPORT_FILE") >/dev/null 2>&1 || true
