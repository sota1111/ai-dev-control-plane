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
RESUME_MODE=false
RESUME_ISSUE=""
DRY_RUN=false

# 簡易引数パース
while [[ $# -gt 0 ]]; do
  case "$1" in
    --resume)
      RESUME_MODE=true
      PROMPT_FILE="prompts/claude/auto_resume.md"
      # 次の引数がフラグでなければ Issue ID とみなす
      if [[ -n "${2:-}" && ! "$2" == --* ]]; then
        RESUME_ISSUE="$2"
        shift
      fi
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      # 未知の引数は無視またはエラー（ここでは一旦無視）
      shift
      ;;
  esac
done

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

if [[ "$DRY_RUN" == true ]]; then
  echo "== Dry run: prompt contents ($PROMPT_FILE) =="
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

# ── 容量プリフライト（Issue追加不可検知 → 自動アーカイブ） ──────────────────────
# Linear のワークスペース上限（無料プランは 250 Issue）に達すると新規 Issue を
# 追加できなくなる。autonomous runner は子Issueを作成するため、上限に近づいたら
# 自動でアーカイブを実行して容量を確保する。
#   ISSUE_CAP_TRIGGER: この件数以上で「追加不可」とみなしアーカイブを実行（既定 245）
# アーカイブは親150/全200を維持する archive_linear_issues.sh に委譲する。
# 失敗（APIキー未設定・取得失敗・アーカイブ失敗）は警告のみで run は継続する。
ISSUE_CAP_TRIGGER="${ISSUE_CAP_TRIGGER:-245}"
if [ -z "${LINEAR_API_KEY:-}" ]; then
  echo "[CAPACITY] WARN LINEAR_API_KEY unset; skipping capacity preflight"
else
  set +e
  ISSUE_TOTAL="$(bash scripts/ai/archive_linear_issues.sh --print-total 2>/dev/null)"
  PRINT_TOTAL_RC=$?
  set -e
  if [ "$PRINT_TOTAL_RC" -ne 0 ] || ! [[ "$ISSUE_TOTAL" =~ ^[0-9]+$ ]]; then
    echo "[CAPACITY] WARN could not determine issue count (rc=${PRINT_TOTAL_RC}, value='${ISSUE_TOTAL}'); continuing"
  elif [ "$ISSUE_TOTAL" -ge "$ISSUE_CAP_TRIGGER" ]; then
    echo "[CAPACITY] Linear issues=${ISSUE_TOTAL} >= trigger=${ISSUE_CAP_TRIGGER}; running archive to free space"
    set +e
    bash scripts/ai/archive_linear_issues.sh --execute
    ARCHIVE_RC=$?
    set -e
    if [ "$ARCHIVE_RC" -ne 0 ]; then
      echo "[CAPACITY] WARN archive failed (rc=${ARCHIVE_RC}); continuing"
    fi
  else
    echo "[CAPACITY] Linear issues=${ISSUE_TOTAL} < trigger=${ISSUE_CAP_TRIGGER}; ok"
  fi
fi
# ─────────────────────────────────────────────────────────────────────────────

RUNTIME_PROMPT="$(cat "$PROMPT_FILE")"

if [[ "$RESUME_MODE" == true ]]; then
  RESUME_ISSUE="${RESUME_ISSUE:-${WEBHOOK_ISSUE_ID:-}}"
  if [[ -z "$RESUME_ISSUE" ]]; then
    echo "Error: --resume requires an issue ID or WEBHOOK_ISSUE_ID environment variable." >&2
    exit 1
  fi
  RUNTIME_PROMPT="## Issue-Rerun Resume Mode

This is a usage-limit resume run for Issue: ${RESUME_ISSUE}

Context:
- Resume metadata file: docs/ai/auto_logs/resume/${RESUME_ISSUE}.json
- This is a continuation of a previous run that hit a usage limit.
- Process only ${RESUME_ISSUE}. Do not search for or select other Linear issues.
- Treat this as a continuation of the existing work, not a new task.
- When ${RESUME_ISSUE} reaches a terminal outcome, exit 0 or 1 and stop.

Mandatory Resume Flow:
1. Read the resume metadata JSON if it exists.
2. Read the previous run log referenced in the metadata.
3. Check the Linear issue's latest status, comments, and current git state.
4. If the issue is already terminal (Completed/Canceled/Archived/Duplicate), stop and exit.
5. If status is 'Todo', set it to 'In Progress'.
6. Remove 'usage-limit' label if present.
7. Post a resume-start comment on Linear.
8. Continue the work from where it left off.

---

${RUNTIME_PROMPT}"

elif [[ -n "${WEBHOOK_ISSUE_ID:-}" ]]; then
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

  # Linearプロジェクトから解決した開発対象レポジトリ（runner が WEBHOOK_TARGET_REPO に注入）。
  # セットされていれば、worker 委譲時の TARGET_REPO を明示する指示行をプロンプトへ追記する。
  if [[ -n "${WEBHOOK_TARGET_REPO:-}" ]]; then
    RUNTIME_PROMPT="## Target Repository (resolved from Linear project)

Target repository for this issue: ${WEBHOOK_TARGET_REPO} (project: ${WEBHOOK_PROJECT_NAME:-unknown}).
When delegating to Gemini/Codex workers, set TARGET_REPO=${WEBHOOK_TARGET_REPO} before running scripts/ai/run_gemini.sh or scripts/ai/run_codex.sh.

---

${RUNTIME_PROMPT}"
  fi
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
  --model opus \
  --dangerously-skip-permissions \
  --output-format stream-json \
  --verbose \
  -p "$RUNTIME_PROMPT" \
  2>&1 | python3 -u -c "$_STREAM_FILTER" | tee "$LOG_FILE"

EXIT_CODE=${PIPESTATUS[0]}
COMPLETION_UNVERIFIED=70

# 完了検証ステップ
if [ "$EXIT_CODE" -eq 0 ]; then
  # worker レポートの ## Next Action を確認する
  NEXT_ACTION=""
  if [ -f "docs/ai/50_worker_gemini_report.md" ]; then
    # 直近の Gemini レポート
    NEXT_ACTION=$(grep "## Next Action" docs/ai/50_worker_gemini_report.md -A 1 | tail -n 1)
  elif [ -f "docs/ai/60_worker_codex_report.md" ]; then
    # Gemini がない場合は Codex レポート
    NEXT_ACTION=$(grep "## Next Action" docs/ai/60_worker_codex_report.md -A 1 | tail -n 1)
  fi

  case "$NEXT_ACTION" in
    *NEEDS_DEBUG*|*NEEDS_USER_INPUT*|*BLOCKED*)
      echo "COMPLETION_CONTRACT: INCOMPLETE reason=report indicates $NEXT_ACTION"
      EXIT_CODE=$COMPLETION_UNVERIFIED
      ;;
    *)
      # 明示的に未完了でなければ完了とみなす
      echo "COMPLETION_CONTRACT: COMPLETED"
      ;;
  esac
fi

echo ""
echo "== Finished: $(date +"%Y%m%d_%H%M%S") (exit: ${EXIT_CODE}) =="
exit "$EXIT_CODE"
