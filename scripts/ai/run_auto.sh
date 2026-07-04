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

# Lane-aware exclusion lock (SOT-933, N-slot parallel pool). The default/unset lane keeps the
# historical GLOBAL lock path so existing single-lane behavior is byte-for-byte unchanged. A
# non-default RUNNER_LANE gets its OWN lock file so distinct lanes (別repo / 別branch worktree) can
# run run_auto.sh concurrently instead of all serializing on one global flock. The lane token is
# sanitized to [a-zA-Z0-9_-] so it can never escape /tmp.
RUNNER_LANE_SANITIZED="$(printf '%s' "${RUNNER_LANE:-}" | tr -cd 'a-zA-Z0-9_-')"
if [ -z "$RUNNER_LANE_SANITIZED" ] || [ "$RUNNER_LANE_SANITIZED" = "default" ]; then
  LOCK_FILE="/tmp/l-concierge-auto-run.lock"
else
  LOCK_FILE="/tmp/l-concierge-auto-run.${RUNNER_LANE_SANITIZED}.lock"
fi

if [ ! -f "$PROMPT_FILE" ]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
mkdir -p docs/ai/linear

# SOT-1459: scope same-worker session cache reuse to a single run. Clearing the per-run worker
# session markers at start means dispatched claude/codex/antigravity workers begin a fresh session
# for this issue (warm cache within the run, no leakage of one issue's context into the next).
rm -f "$LOG_DIR"/claude_worker_session*.id "$LOG_DIR"/*_worker_session*.marker 2>/dev/null || true

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
#   ISSUE_CAP_PREFLIGHT: 0/false/no/off でプリフライト全体を無効化（既定 有効）
#   ISSUE_CAP_PREFLIGHT_TTL: 直近スキャン結果のキャッシュ秒数（既定 3600=1h, SOT-1514 / P3）。
#     TTL 内かつ前回件数が trigger 未満なら Linear への全Issue件数スキャン（毎run のネットワーク
#     往復）をスキップする。閾値近傍（>= trigger）や TTL 切れ時のみ再スキャンし、アーカイブ実行後は
#     件数が変わるためキャッシュを破棄して次回再スキャンさせる。
# アーカイブは親150/全200を維持する archive_linear_issues.sh に委譲する。
# 失敗（APIキー未設定・取得失敗・アーカイブ失敗）は警告のみで run は継続する。
ISSUE_CAP_TRIGGER="${ISSUE_CAP_TRIGGER:-245}"
ISSUE_CAP_PREFLIGHT_TTL="${ISSUE_CAP_PREFLIGHT_TTL:-3600}"
ISSUE_CAP_CACHE_FILE="${LOG_DIR}/issue_count_cache.json"
_preflight_enabled=1
case "$(printf '%s' "${ISSUE_CAP_PREFLIGHT:-1}" | tr '[:upper:]' '[:lower:]')" in
  0|false|no|off) _preflight_enabled=0 ;;
esac
if [ "$_preflight_enabled" -eq 0 ]; then
  echo "[CAPACITY] preflight disabled by ISSUE_CAP_PREFLIGHT; skipping"
elif [ -z "${LINEAR_API_KEY:-}" ]; then
  echo "[CAPACITY] WARN LINEAR_API_KEY unset; skipping capacity preflight"
else
  # TTL キャッシュ: 前回件数が新鮮（age < TTL）かつ trigger 未満ならネットワークスキャンを省く。
  NOW_EPOCH="$(date +%s)"
  CACHED_TOTAL=""
  CACHE_AGE=""
  if [ -f "$ISSUE_CAP_CACHE_FILE" ]; then
    CACHED_TOTAL="$(node -e "try{const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(Number(d.total)));}catch(e){process.stdout.write('');}" "$ISSUE_CAP_CACHE_FILE" 2>/dev/null || echo '')"
    CACHED_TS="$(node -e "try{const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(Number(d.ts)||0));}catch(e){process.stdout.write('0');}" "$ISSUE_CAP_CACHE_FILE" 2>/dev/null || echo 0)"
    if [[ "$CACHED_TS" =~ ^[0-9]+$ ]] && [ "$CACHED_TS" -gt 0 ]; then CACHE_AGE="$((NOW_EPOCH - CACHED_TS))"; fi
  fi
  if [[ "$CACHED_TOTAL" =~ ^[0-9]+$ ]] && [ -n "$CACHE_AGE" ] && [ "$CACHE_AGE" -ge 0 ] \
     && [ "$CACHE_AGE" -lt "$ISSUE_CAP_PREFLIGHT_TTL" ] && [ "$CACHED_TOTAL" -lt "$ISSUE_CAP_TRIGGER" ]; then
    echo "[CAPACITY] cached issues=${CACHED_TOTAL} < trigger=${ISSUE_CAP_TRIGGER} (age ${CACHE_AGE}s < ttl ${ISSUE_CAP_PREFLIGHT_TTL}s); skipping scan"
  else
    set +e
    ISSUE_TOTAL="$(bash scripts/ai/archive_linear_issues.sh --print-total 2>/dev/null)"
    PRINT_TOTAL_RC=$?
    set -e
    if [ "$PRINT_TOTAL_RC" -ne 0 ] || ! [[ "$ISSUE_TOTAL" =~ ^[0-9]+$ ]]; then
      echo "[CAPACITY] WARN could not determine issue count (rc=${PRINT_TOTAL_RC}, value='${ISSUE_TOTAL}'); continuing"
    else
      node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({total:Number(process.argv[2]),ts:Number(process.argv[3])}));" "$ISSUE_CAP_CACHE_FILE" "$ISSUE_TOTAL" "$NOW_EPOCH" 2>/dev/null || true
      if [ "$ISSUE_TOTAL" -ge "$ISSUE_CAP_TRIGGER" ]; then
        echo "[CAPACITY] Linear issues=${ISSUE_TOTAL} >= trigger=${ISSUE_CAP_TRIGGER}; running archive to free space"
        set +e
        bash scripts/ai/archive_linear_issues.sh --execute
        ARCHIVE_RC=$?
        set -e
        if [ "$ARCHIVE_RC" -ne 0 ]; then
          echo "[CAPACITY] WARN archive failed (rc=${ARCHIVE_RC}); continuing"
        else
          # アーカイブで件数が変化したのでキャッシュを破棄し次回再スキャンさせる
          rm -f "$ISSUE_CAP_CACHE_FILE"
        fi
      else
        echo "[CAPACITY] Linear issues=${ISSUE_TOTAL} < trigger=${ISSUE_CAP_TRIGGER}; ok"
      fi
    fi
  fi
fi
# ─────────────────────────────────────────────────────────────────────────────

COMPLETION_UNVERIFIED=70

# ── 完全スクリプト駆動ロールパイプライン（案B / SOT-1459） ─────────────────────────
# run_auto.sh 自身が task-check → decomposition → implementation → verification → acceptance →
# github → linear-report を順に `scripts/ai/run_worker.sh <role>` で実行する。各ロールの worker 選択・
# 優先度チェーン・フォールバック・usage-limit 引き継ぎ・同一AIキャッシュ再利用はディスパッチャが担う。
# Claude を「全工程を統括する単一オーケストレータ」としては起動せず、各ロールを個別の委譲 worker として
# 回す。これにより「AI が AI を呼ぶ」構造を排し、工程順序はスクリプトが確定的に駆動する。
#
# 適用条件: 対象 issue が確定していること（WEBHOOK_ISSUE_ID / --resume）。runner.ts は常に
# WEBHOOK_ISSUE_ID を注入するため、autonomous 経路は必ずこのパイプラインを通る。issue 未指定の手動起動
# （キュー走査）や `PIPELINE_MODE=0` のときは、後方互換のためレガシーの単一オーケストレータ起動へ退避する。
plog() { echo "[pipeline] $*" | tee -a "$LOG_FILE"; }

run_role_pipeline() {
  local issue="$1"
  local target_repo="${WEBHOOK_TARGET_REPO:-${TARGET_REPO:-}}"
  [ -n "$target_repo" ] && export TARGET_REPO="$target_repo"

  # 各ロールプロンプト（prompts/roles/<role>.md）が読む共有コンテキストを書き出す。
  mkdir -p docs/ai/pipeline
  {
    echo "# Pipeline Context (run $TIMESTAMP)"
    echo ""
    echo "- Target Linear issue: $issue"
    echo "- Target repository: ${target_repo:-<none: operate in this control-plane repo>}"
    echo "- Project: ${WEBHOOK_PROJECT_NAME:-unknown}"
    echo "- Mode: $([ "${RESUME_MODE:-false}" = true ] && echo 'resume (continue previous usage-limited run)' || echo normal)"
    echo "- Resume metadata (if resume): docs/ai/auto_logs/resume/$issue.json"
    echo ""
    echo "Process ONLY this issue. Do not select or process other Linear issues."
  } > docs/ai/pipeline/context.md

  local roles=(task-check decomposition implementation verification acceptance github linear-report)
  local n=${#roles[@]}
  local impl_index=2 verify_index=3
  local i=0 debug_cycles=0
  local MAX_DEBUG_CYCLES="${PIPELINE_MAX_DEBUG_CYCLES:-2}"

  while [ "$i" -lt "$n" ]; do
    local role="${roles[$i]}"
    plog "── role[$i]: $role (issue $issue) ──"

    if [ ! -s "prompts/roles/$role.md" ]; then
      plog "PIPELINE_STOP: missing canonical prompt prompts/roles/$role.md"
      return "$COMPLETION_UNVERIFIED"
    fi

    # Run the dispatcher; stream to the log AND capture output to parse the winning report path.
    local cap; cap="$(mktemp)"
    set +e
    bash scripts/ai/run_worker.sh "$role" 2>&1 | tee -a "$LOG_FILE" "$cap" >/dev/null
    local rc=${PIPESTATUS[0]}
    set -e

    local report; report="$(grep -oE 'WORKER_DISPATCH_DONE role=[^ ]+ worker=[^ ]+ report=[^ ]+' "$cap" 2>/dev/null | sed 's/.*report=//' | tail -1 || true)"
    rm -f "$cap"

    if [ "$rc" -ne 0 ] || [ -z "$report" ] || [ ! -f "$report" ]; then
      plog "PIPELINE_STOP: role=$role dispatcher rc=$rc (chain exhausted / no report) → needs attention"
      return "$COMPLETION_UNVERIFIED"
    fi

    local na; na="$(grep -A1 '## Next Action' "$report" 2>/dev/null | tail -n1 | tr -d ' \r\t' || true)"
    plog "role=$role next_action='${na:-<none>}' report=$report"

    case "$role" in
      task-check)
        case "$na" in
          *READY_FOR_REVIEW*) ;;  # actionable → proceed
          *) plog "PIPELINE_DONE: task-check reports not-actionable ('$na') → success no-op"; return 0 ;;
        esac
        ;;
      verification|acceptance)
        case "$na" in
          *READY_FOR_REVIEW*) ;;  # passed → proceed
          *NEEDS_DEBUG*)
            if [ "$debug_cycles" -lt "$MAX_DEBUG_CYCLES" ]; then
              debug_cycles=$((debug_cycles + 1))
              plog "PIPELINE_LOOP: $role NEEDS_DEBUG → re-run implementation (cycle $debug_cycles/$MAX_DEBUG_CYCLES)"
              i="$impl_index"; continue
            fi
            plog "PIPELINE_STOP: $role still NEEDS_DEBUG after $MAX_DEBUG_CYCLES cycles → needs attention"
            return "$COMPLETION_UNVERIFIED"
            ;;
          *) plog "PIPELINE_STOP: $role '$na' → stop (needs human)"; return "$COMPLETION_UNVERIFIED" ;;
        esac
        ;;
      *)
        case "$na" in
          *READY_FOR_REVIEW*) ;;  # proceed
          *NEEDS_DEBUG*)
            if [ "$debug_cycles" -lt "$MAX_DEBUG_CYCLES" ]; then
              debug_cycles=$((debug_cycles + 1))
              plog "PIPELINE_LOOP: $role NEEDS_DEBUG → re-run verification (cycle $debug_cycles/$MAX_DEBUG_CYCLES)"
              i="$verify_index"; continue
            fi
            return "$COMPLETION_UNVERIFIED"
            ;;
          *) plog "PIPELINE_STOP: $role '$na' → stop (needs human)"; return "$COMPLETION_UNVERIFIED" ;;
        esac
        ;;
    esac

    i=$((i + 1))
  done

  plog "PIPELINE_DONE: all roles completed for $issue"
  return 0
}

TARGET_ISSUE="${RESUME_ISSUE:-${WEBHOOK_ISSUE_ID:-}}"
PIPELINE_ENABLED=1
case "$(printf '%s' "${PIPELINE_MODE:-1}" | tr '[:upper:]' '[:lower:]')" in
  0|false|no|off) PIPELINE_ENABLED=0 ;;
esac

if [ "$PIPELINE_ENABLED" -eq 1 ] && [ -n "$TARGET_ISSUE" ]; then
  echo "== Auto Runner: script-driven role pipeline (issue $TARGET_ISSUE) =="
  echo "Start: ${TIMESTAMP}"
  echo "Log: ${LOG_FILE}"
  echo ""
  set +e
  run_role_pipeline "$TARGET_ISSUE"
  EXIT_CODE=$?
  set -e
  echo ""
  echo "== Finished pipeline: $(date +"%Y%m%d_%H%M%S") (exit: ${EXIT_CODE}) =="
  exit "$EXIT_CODE"
fi

# ── レガシー経路（issue 未指定 or PIPELINE_MODE=0）: 単一 Claude オーケストレータ起動 ──────────────
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
- When ${RESUME_ISSUE} reaches a terminal outcome or there is no work to do, this is a SUCCESS: exit 0 and stop. Reserve a non-zero exit for actual errors only (a non-zero exit is treated downstream as a failure and may be misclassified as a usage limit).

Mandatory Resume Flow:
1. Read the resume metadata JSON if it exists.
2. Read the previous run log referenced in the metadata.
3. Check the Linear issue's latest status, comments, and current git state.
4. If the issue is already terminal (Completed/Canceled/Archived/Duplicate) or is on hold awaiting human review (In Review), stop and exit 0 (this is a successful no-op, not a failure).
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
- Perform the initial task check exactly once, via the dispatcher (NOT by calling a worker directly).
  Write the task-check instruction to prompts/roles/task-check.md, then run
  \`scripts/ai/run_worker.sh task-check\`. The dispatcher tries the task-check priority chain from
  config/worker_roles.json (default codex → claude → antigravity), hands off to the next worker on
  non-response / usage-limit, and prints \`WORKER_DISPATCH_DONE role=task-check worker=<w> report=<path>\`.
  Read that report path for the result (target issue status, latest comments, labels, acceptance
  criteria, and whether it is actionable).
- ROUTE ALL ROLE WORK THROUGH THE DISPATCHER. For every role (task-check, decomposition, implementation,
  verification, acceptance, github, linear-report), write the instruction to prompts/roles/<role>.md and
  run \`scripts/ai/run_worker.sh <role>\`. NEVER call scripts/ai/run_codex.sh, scripts/ai/run_antigravity.sh,
  or a nested claude directly — the dispatcher owns worker selection, priority-chain fallback, same-AI
  session/cache reuse, and usage-limit handoff. Read the report path printed as WORKER_DISPATCH_DONE.
  If the dispatcher prints WORKER_DISPATCH_EXHAUSTED (exit 75, every worker in the chain non-responsive),
  perform that role's work yourself per the Worker Non-Response Fallback Policy.
- After the task check is complete, Claude Code owns sequencing the remaining roles (decomposition, child
  issue registration, Linear status updates, PR flow, and final reporting) — each executed through the
  dispatcher as above.
- When ${WEBHOOK_ISSUE_ID} reaches a terminal outcome for this run, or there is no actionable work (e.g. already terminal, or on hold In Review), this is a SUCCESS: exit immediately with 0. Reserve a non-zero exit for actual errors only. Do not re-check the Linear queue and do not continue to another issue.

---

${RUNTIME_PROMPT}"

  # Linearプロジェクトから解決した開発対象レポジトリ（runner が WEBHOOK_TARGET_REPO に注入）。
  # セットされていれば、worker 委譲時の TARGET_REPO を明示する指示行をプロンプトへ追記する。
  if [[ -n "${WEBHOOK_TARGET_REPO:-}" ]]; then
    RUNTIME_PROMPT="## Target Repository (resolved from Linear project)

Target repository for this issue: ${WEBHOOK_TARGET_REPO} (project: ${WEBHOOK_PROJECT_NAME:-unknown}).
When dispatching worker roles, set TARGET_REPO=${WEBHOOK_TARGET_REPO} before running scripts/ai/run_worker.sh <role> (the dispatcher forwards TARGET_REPO to whichever worker it selects).

---

${RUNTIME_PROMPT}"
  fi
fi

echo "== Claude Code Auto Runner =="
echo "Start: ${TIMESTAMP}"
echo "Log: ${LOG_FILE}"
echo ""

# stream-json イベントから assistant のテキスト、ツール呼び出し、
# Antigravity/Codex の出力（tool_result）をリアルタイム抽出。
#
# SOT-1457: すべての行に「誰が作業しているか」を示すアクタータグ [<actor>] を付ける。
#   - orchestrator（Claude Code 本体）のナレーション/ツール呼び出し → [<model>]（既定 [opus], sonnet 対応）
#   - 実際の Codex 出力（== Codex CLI バナー）              → [codex]
#   - 実際の Antigravity 出力（== Antigravity CLI バナー）   → [agy]
# これにより「Codex が実際には動いていない run」では実体のある [codex] 行が出ず、
# 委譲バイパス（"delegating to Claude"）だけが [codex] で残るため、
# codex が作業していないことがログから判別できる。orchestrator が "Codex is still
# running..." と語っても [opus]/[sonnet] タグが付くので、発話者が Claude 本体だと分かる。
# runner.ts が付ける [RUN:<id>] と合成され [RUN:<id>] [opus] / [RUN:<id>] [codex] になる。
_STREAM_FILTER='
import sys, json, os

WORKER_MARKERS = ("== Antigravity CLI", "== Codex CLI")

def orch_actor():
    """orchestrator（Claude 本体）のアクター名を短い名前に正規化する。
    CLAUDE_MODEL が claude-opus-4-8 / opus / claude-sonnet-4-6 / sonnet / haiku
    のいずれでも [opus] / [sonnet] / [haiku] に揃える（既定 opus）。"""
    m = (os.environ.get("CLAUDE_MODEL") or "opus").lower()
    for short in ("opus", "sonnet", "haiku"):
        if short in m:
            return short
    return m

# orchestrator（Claude Code 本体）のアクター名。run_auto.sh の --model と揃える。
ORCH = orch_actor()

def tag_lines(actor, text):
    """text の各行に [actor] を付けて出力する（空行はスキップ）。"""
    for ln in text.splitlines():
        if ln.strip() == "":
            continue
        print(f"[{actor}] {ln}", flush=True)

def worker_actor(text):
    """worker バナーから codex / agy(Antigravity) を判定する。"""
    if text.startswith("== Codex CLI"):
        return "codex"
    if text.startswith("== Antigravity CLI"):
        return "agy"
    return None

def emit_worker_result(content):
    """tool_result の中身が Antigravity/Codex 出力なら worker アクター付きで表示する"""
    if isinstance(content, str):
        actor = worker_actor(content)
        if actor:
            tag_lines(actor, content)
    elif isinstance(content, list):
        for c in content:
            if isinstance(c, dict) and c.get("type") == "text":
                txt = c.get("text", "")
                actor = worker_actor(txt)
                if actor:
                    tag_lines(actor, txt)

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
                        tag_lines(ORCH, txt)
                elif bt == "tool_use":
                    name = blk.get("name", "?")
                    inp = blk.get("input", {})
                    d = (inp.get("command") or inp.get("file_path") or
                         inp.get("path") or inp.get("query") or
                         inp.get("pattern") or "")
                    if d:
                        print(f"[{ORCH}] [{name}] {str(d)[:120]}", flush=True)
                    else:
                        print(f"[{ORCH}] [{name}]", flush=True)
        elif t == "user":
            for blk in ev.get("message", {}).get("content", []):
                if blk.get("type") == "tool_result":
                    emit_worker_result(blk.get("content", ""))
        elif t == "result" and ev.get("is_error"):
            tag_lines(ORCH, "ERROR: " + ev.get("result", ""))
    except Exception:
        if line:
            print(line, flush=True)
'

CLAUDE_MODEL="${CLAUDE_MODEL:-opus}"
export CLAUDE_MODEL
claude \
  --model "$CLAUDE_MODEL" \
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
  if [ -f "docs/ai/50_worker_antigravity_report.md" ]; then
    # 直近の Antigravity レポート
    NEXT_ACTION=$(grep "## Next Action" docs/ai/50_worker_antigravity_report.md -A 1 | tail -n 1)
  elif [ -f "docs/ai/60_worker_codex_report.md" ]; then
    # Antigravity がない場合は Codex レポート
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
