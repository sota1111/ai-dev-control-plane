#!/usr/bin/env bash
set -euo pipefail

# Claude Code 自律実行スクリプト
# Linear issue を優先度順に処理する
# 使い方:
#   ./scripts/ai/run_auto.sh              # 通常実行（ログは自動採番）
#   ./scripts/ai/run_auto.sh --dry-run    # プロンプト内容の確認のみ
#
# 多重起動防止:
#   スクリプト経由の起動は同時に1プロセスのみ許可する（flock による排他制御）。
#   ユーザーによる手動起動（VSCode / 直接 terminal）はこのロックを使わないため
#   カウントされない。

cd "$(dirname "$0")/../.."

PROMPT_FILE="prompts/claude/auto_run.md"
LOG_DIR="docs/ai/auto_logs"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
LOG_FILE="${LOG_DIR}/run_${TIMESTAMP}.log"
LOCK_FILE="/tmp/l-concierge-auto-run.lock"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
mkdir -p docs/ai/linear

if [[ "${1:-}" == "--dry-run" ]]; then
  echo "== Dry run: prompt contents =="
  cat "$PROMPT_FILE"
  exit 0
fi

# ── 多重起動ガード ────────────────────────────────────────────────────────────
# flock -n : ロックが取得できなければ即座に失敗（非ブロッキング）
# ロックはシェルプロセス終了時に OS が自動解放するためクリーンアップ不要
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] run_auto.sh is already running (script-launched). Skipping." >&2
  exit 75
fi
# ─────────────────────────────────────────────────────────────────────────────

RUNTIME_PROMPT="$(cat "$PROMPT_FILE")"

if [[ -n "${WEBHOOK_ISSUE_ID:-}" ]]; then
  RUNTIME_PROMPT="## Webhook Single-Issue Mode

This run was triggered by Linear webhook for Issue: ${WEBHOOK_ISSUE_ID}

Mandatory behavior:
- Process only ${WEBHOOK_ISSUE_ID}. Do not search for or select other Linear issues.
- Perform the initial task check exactly once. The task check must be delegated to Codex CLI before Claude Code starts decomposition.
- For the Codex task check, write instructions to prompts/codex/debug.md, run scripts/ai/run_codex.sh, and read docs/ai/60_worker_codex_report.md. The check should verify the target issue status, latest comments, labels, acceptance criteria, and whether it is actionable.
- After the Codex task check is complete, Claude Code owns decomposition, child issue registration, worker delegation, Linear status updates, PR flow, and final reporting.
- When ${WEBHOOK_ISSUE_ID} reaches a terminal outcome for this run, exit immediately with 0 or 1. Do not re-check the Linear queue and do not continue to another issue.

---

${RUNTIME_PROMPT}"
fi

echo "== Claude Code Auto Runner =="
echo "Start: ${TIMESTAMP}"
echo "Log: ${LOG_FILE}"
echo ""

# stream-json イベントから assistant のテキスト、ツール呼び出し、
# Gemini/Codex の出力（tool_result）をリアルタイム抽出
_STREAM_FILTER='
import sys, json

WORKER_MARKERS = ("== Gemini CLI", "== Codex CLI")

def emit_worker_result(content):
    """tool_result の中身が Gemini/Codex 出力なら表示する"""
    if isinstance(content, str):
        if content.startswith(WORKER_MARKERS):
            print(content, end="" if content.endswith("\n") else "\n", flush=True)
    elif isinstance(content, list):
        for c in content:
            if isinstance(c, dict) and c.get("type") == "text":
                txt = c.get("text", "")
                if txt.startswith(WORKER_MARKERS):
                    print(txt, end="" if txt.endswith("\n") else "\n", flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        ev = json.loads(line)
        t = ev.get("type", "")
        if t == "assistant":
            for blk in ev.get("message", {}).get("content", []):
                bt = blk.get("type", "")
                if bt == "text":
                    txt = blk.get("text", "")
                    if txt.strip():
                        print(txt, end="" if txt.endswith("\n") else "\n", flush=True)
                elif bt == "tool_use":
                    name = blk.get("name", "?")
                    inp = blk.get("input", {})
                    d = (inp.get("command") or inp.get("file_path") or
                         inp.get("path") or inp.get("query") or
                         inp.get("pattern") or "")
                    if d:
                        print(f"[{name}] {str(d)[:120]}", flush=True)
                    else:
                        print(f"[{name}]", flush=True)
        elif t == "user":
            for blk in ev.get("message", {}).get("content", []):
                if blk.get("type") == "tool_result":
                    emit_worker_result(blk.get("content", ""))
        elif t == "result" and ev.get("is_error"):
            print("ERROR: " + ev.get("result", ""), flush=True)
    except Exception:
        if line:
            print(line, flush=True)
'

claude \
  --dangerously-skip-permissions \
  --output-format stream-json \
  --verbose \
  -p "$RUNTIME_PROMPT" \
  2>&1 | python3 -u -c "$_STREAM_FILTER" | tee "$LOG_FILE"

EXIT_CODE=${PIPESTATUS[0]}

echo ""
echo "== Finished: $(date +"%Y%m%d_%H%M%S") (exit: ${EXIT_CODE}) =="
exit "$EXIT_CODE"
