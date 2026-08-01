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

# Repository routing safety gate. runner.ts sets this marker when an explicitly assigned Linear
# project cannot be resolved to a repository. Exit retryably before locks, capacity checks, or any
# worker invocation so an unknown project can never be executed in the control-plane checkout.
if [ -n "${RUNNER_REPO_RESOLUTION_ERROR:-}" ]; then
  echo "REPO_RESOLUTION_UNAVAILABLE: ${RUNNER_REPO_RESOLUTION_ERROR}" >&2
  exit 71
fi

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
#   ISSUE_CAP_PREFLIGHT_TIMEOUT: 容量スキャン全体の上限秒数（既定 90）
#   ISSUE_CAP_PREFLIGHT_TTL: 直近スキャン結果のキャッシュ秒数（既定 3600=1h, SOT-1514 / P3）。
#     TTL 内かつ前回件数が trigger 未満なら Linear への全Issue件数スキャン（毎run のネットワーク
#     往復）をスキップする。閾値近傍（>= trigger）や TTL 切れ時のみ再スキャンし、アーカイブ実行後は
#     件数が変わるためキャッシュを破棄して次回再スキャンさせる。
# アーカイブは親150/子50を維持する archive_linear_issues.sh に委譲する（各カテゴリ古い順・作業中除外）。
# 失敗（APIキー未設定・取得失敗・アーカイブ失敗）は警告のみで run は継続する。
ISSUE_CAP_TRIGGER="${ISSUE_CAP_TRIGGER:-245}"
ISSUE_CAP_PREFLIGHT_TIMEOUT="${ISSUE_CAP_PREFLIGHT_TIMEOUT:-90}"
ISSUE_CAP_PREFLIGHT_TTL="${ISSUE_CAP_PREFLIGHT_TTL:-3600}"
ISSUE_CAP_CACHE_FILE="${LOG_DIR}/issue_count_cache.json"
if ! [[ "$ISSUE_CAP_PREFLIGHT_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
  echo "[CAPACITY] WARN invalid ISSUE_CAP_PREFLIGHT_TIMEOUT='${ISSUE_CAP_PREFLIGHT_TIMEOUT}'; using 90s"
  ISSUE_CAP_PREFLIGHT_TIMEOUT=90
fi
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
    ISSUE_TOTAL="$(timeout --signal=TERM --kill-after=5s "${ISSUE_CAP_PREFLIGHT_TIMEOUT}s" \
      bash scripts/ai/archive_linear_issues.sh --print-total 2>/dev/null)"
    PRINT_TOTAL_RC=$?
    set -e
    if [ "$PRINT_TOTAL_RC" -ne 0 ] || ! [[ "$ISSUE_TOTAL" =~ ^[0-9]+$ ]]; then
      echo "[CAPACITY] WARN could not determine issue count (rc=${PRINT_TOTAL_RC}, value='${ISSUE_TOTAL}'); continuing"
    else
      node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({total:Number(process.argv[2]),ts:Number(process.argv[3])}));" "$ISSUE_CAP_CACHE_FILE" "$ISSUE_TOTAL" "$NOW_EPOCH" 2>/dev/null || true
      if [ "$ISSUE_TOTAL" -ge "$ISSUE_CAP_TRIGGER" ]; then
        echo "[CAPACITY] Linear issues=${ISSUE_TOTAL} >= trigger=${ISSUE_CAP_TRIGGER}; running archive to free space"
        # Run-ownership guard (SOT-1546): protect the Issue this run is holding from
        # being swept by the capacity archive, even while it is still Todo (the
        # In Progress state-guard cannot help before the transition). Pass the run's
        # target id plus any in-flight run's current-issue marker as --exclude-id.
        ARCHIVE_EXCLUDE_ARGS=()
        if [ -n "${WEBHOOK_ISSUE_ID:-}" ]; then
          ARCHIVE_EXCLUDE_ARGS+=(--exclude-id "${WEBHOOK_ISSUE_ID}")
        fi
        if [ -f "${LOG_DIR}/current-issue.json" ]; then
          CUR_ISSUE_ID="$(node -e "try{const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(d.issueId||''));}catch(e){process.stdout.write('');}" "${LOG_DIR}/current-issue.json" 2>/dev/null || echo '')"
          if [ -n "$CUR_ISSUE_ID" ] && [ "$CUR_ISSUE_ID" != "${WEBHOOK_ISSUE_ID:-}" ]; then
            ARCHIVE_EXCLUDE_ARGS+=(--exclude-id "$CUR_ISSUE_ID")
          fi
        fi
        set +e
        timeout --signal=TERM --kill-after=5s "${ISSUE_CAP_PREFLIGHT_TIMEOUT}s" \
          bash scripts/ai/archive_linear_issues.sh --execute "${ARCHIVE_EXCLUDE_ARGS[@]}"
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
# SOT-1584: the pipeline stopped because the WHOLE worker chain was TRANSIENTLY non-responsive
# (dispatcher exit 75 / WORKER_DISPATCH_EXHAUSTED: usage cooldown, auth crash, disabled) — NOT a genuine
# "one full pass, still can't complete" stop. This is distinct from COMPLETION_UNVERIFIED (70) so the
# top-level does NOT fire the ensure-issue-reviewed loop-breaker (which would falsely move the issue to
# In Review and strand ready work) and the runner re-enqueues it with backoff to retry when a worker recovers.
WORKER_UNAVAILABLE=71

# ── 完全スクリプト駆動ロールパイプライン（案B / SOT-1459） ─────────────────────────
# run_auto.sh 自身が task-check → implementation → verification → acceptance →
# github → linear-report を順に `scripts/ai/run_worker.sh <role>` で実行する。各ロールの worker 選択・
# SOT-1553: task-check と decomposition の worker 切り分けを廃止し、確認＋分解判断＋子Issue登録を単一の
# task-check ロール（同一 worker・1回のディスパッチ）で一度に行う。両者の間にスクリプト（別の
# run_worker.sh 起動やゲート）を挟まない。
# 優先度チェーン・フォールバック・usage-limit 引き継ぎ・同一AIキャッシュ再利用はディスパッチャが担う。
# Claude を「全工程を統括する単一オーケストレータ」としては起動せず、各ロールを個別の委譲 worker として
# 回す。これにより「AI が AI を呼ぶ」構造を排し、工程順序はスクリプトが確定的に駆動する。
#
# 適用条件: 対象 issue が確定していること（WEBHOOK_ISSUE_ID / --resume）。runner.ts は常に
# WEBHOOK_ISSUE_ID を注入するため、autonomous 経路は必ずこのパイプラインを通る。
plog() { echo "[pipeline] $*" | tee -a "$LOG_FILE"; }

# Worker output filter for the pipeline (SOT-1457 の tag 付与を案B 用に復活): strip ANSI color escapes
# (workers emit \x1b[..m colored output → Discord/ログに生エスケープが出るのを防ぐ) and prefix each
# line with the ACTOR tag inferred from the worker banner (== Codex/Antigravity/Claude CLI ==), so the
# Discord/ログ行が `[agy] ...` のように読める。runner.ts が更に `[RUN:<id>]` を前置する。
# SOT-1615: the worker banner now carries a trailing ` model=<model>` (emitted by run_<worker>.sh) when
# the model is known, so the actor tag becomes `[codex-sol]` / `[claude-opus]` etc. — the model is shown
# alongside the AI. No ` model=` on the banner → tag stays the bare `[codex]` (backward compatible).
_PIPE_TAG_FILTER='
import sys, re
ANSI = re.compile(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
MODEL = re.compile(r" model=(.+?)\s*$")
actor = "dispatch"
def worker_of(s):
    if s.startswith("== Codex CLI"): return "codex"
    if s.startswith("== Antigravity CLI"): return "agy"
    if s.startswith("== Claude CLI"): return "claude"
    return None
def actor_of(s):
    w = worker_of(s)
    if not w:
        return None
    m = MODEL.search(s)
    if m:
        # compact the model id for a tag-friendly suffix (ids may carry dots/spaces/parens, e.g.
        # "Gemini 3.5 Flash (High)"): collapse runs of non [\w.-] to a single "-".
        slug = re.sub(r"[^\w.-]+", "-", m.group(1).strip()).strip("-")
        if slug:
            return f"{w}-{slug}"
    return w
for raw in sys.stdin:
    line = ANSI.sub("", raw.rstrip("\n"))
    a = actor_of(line.lstrip())
    if a:
        actor = a
    if line.strip() == "":
        continue
    print(f"[{actor}] {line}", flush=True)
'

# runner-cli helper (mirror run_codex.sh): prefer the local tsx binary, fall back to npx.
_PIPE_TSX_BIN="node_modules/.bin/tsx"
run_cli() {
  if [ -x "$_PIPE_TSX_BIN" ]; then
    "$_PIPE_TSX_BIN" src/runner-cli.ts "$@"
  else
    npx tsx src/runner-cli.ts "$@"
  fi
}

# SOT-1560: circuit breaker CLI (pure stop-condition decision; single source of truth = circuitBreaker.ts).
# Prints `TRIPPED=… BREAKER=… REASON=…` and exits 10 when tripped, 0 otherwise.
run_breaker_cli() {
  if [ -x "$_PIPE_TSX_BIN" ]; then
    "$_PIPE_TSX_BIN" src/circuit-breaker-cli.ts "$@"
  else
    npx tsx src/circuit-breaker-cli.ts "$@"
  fi
}

# SOT-1560: fingerprint the working repo's git state (HEAD commit + dirty tree) so the no-progress
# breaker can tell whether a cycle actually produced a diff/commit. Empty on any error (fail-open).
_cb_fingerprint() {
  local repo="${1:-.}"
  { git -C "$repo" rev-parse HEAD 2>/dev/null; git -C "$repo" status --porcelain 2>/dev/null; } \
    | sha1sum 2>/dev/null | awk '{print $1}'
}

declare -A PIPELINE_EXECUTORS=(
  [worker]=execute_worker_node
  [discussion]=execute_discussion_node
)

execute_worker_node() {
  local issue="$1" role="$2" cap="$3"
  bash scripts/ai/run_worker.sh "$role" 2>&1 | python3 -u -c "$_PIPE_TAG_FILTER" | tee -a "$LOG_FILE" "$cap"
  NODE_RC=${PIPESTATUS[0]}
  local dispatch_done
  dispatch_done="$(grep -oE 'WORKER_DISPATCH_DONE role=[^ ]+ worker=[^ ]+ report=[^ ]+' "$cap" 2>/dev/null | tail -1 || true)"
  NODE_REPORT="$(printf '%s' "$dispatch_done" | sed 's/.*report=//' || true)"
  NODE_WINNER="$(printf '%s' "$dispatch_done" | sed -E 's/.*worker=([^ ]+).*/\1/' || true)"
}

execute_discussion_node() {
  local issue="$1" _role="$2" cap="$3"
  local topic_file="docs/ai/pipeline/discussion_topic.$issue.md"
  if [ -s "$topic_file" ]; then
    bash scripts/ai/run_discussion.sh --issue "$issue" --topic-file "$topic_file" 2>&1 | tee -a "$LOG_FILE" "$cap"
  else
    DISCUSSION_TOPIC="Review Linear issue $issue and agree on the implementation approach before implementation." \
      bash scripts/ai/run_discussion.sh --issue "$issue" 2>&1 | tee -a "$LOG_FILE" "$cap"
  fi
  NODE_RC=${PIPESTATUS[0]}
  NODE_REPORT="docs/ai/pipeline/discussion_$issue.md"
  NODE_WINNER="discussion"
}

# Execute any graph node through its registered executor. The role loop does not need to know which
# roles use the normal dispatcher and which have a purpose-built executor.
executeNode() {
  local issue="$1" role="$2"
  local executor_key="worker"
  [ -n "${PIPELINE_EXECUTORS[$role]:-}" ] && executor_key="$role"
  local executor="${PIPELINE_EXECUTORS[$executor_key]}"
  local cap; cap="$(mktemp)"
  NODE_RC=0 NODE_REPORT="" NODE_WINNER=""
  set +e
  "$executor" "$issue" "$role" "$cap"
  set -e
  rm -f "$cap"
}

# Parse every worker/discussion/solo report through one implementation. Missing files intentionally
# yield empty fields; executeNode/finalizeRun decide whether that is retryable or terminal.
parsePipelineReport() {
  local report="$1"
  REPORT_NEXT_ACTION="" REPORT_ACCEPTANCE="" REPORT_LINEAR_POSTED="" REPORT_HAS_PR=0
  [ -f "$report" ] || return 0
  REPORT_NEXT_ACTION="$(awk '/[Nn]ext[[:space:]]*[Aa]ction/{cap=1; buf=""} cap{buf=buf"\n"$0} END{print buf}' "$report" 2>/dev/null | grep -oiE 'READY_FOR_REVIEW|NEEDS_DEBUG|NEEDS_USER_INPUT|BLOCKED' | head -n1 | tr '[:lower:]' '[:upper:]' || true)"
  REPORT_ACCEPTANCE="$(grep -ioE '^##[[:space:]]*Acceptance:[[:space:]]*(PASS|FAIL)' "$report" 2>/dev/null | grep -ioE '(PASS|FAIL)' | tail -1 | tr '[:lower:]' '[:upper:]' || true)"
  REPORT_LINEAR_POSTED="$(grep -ioE '^##[[:space:]]*Linear[[:space:]]+Report:[[:space:]]*POSTED' "$report" 2>/dev/null | tail -1 || true)"
  grep -qiE 'pull/[0-9]+|PR[ :*]*#[0-9]+' "$report" 2>/dev/null && REPORT_HAS_PR=1
}

# Apply the completion contract in one place for graph and solo runs. This preserves the SOT-1928
# missing-report retry rule and the SOT-2127 acceptance/Linear-report requirements for PR results.
finalizeRun() {
  local mode="$1" rc="$2" report="$3"
  local acceptance_override="${4:-}" linear_override="${5:-}"
  if [ "$rc" -ne 0 ] || [ -z "$report" ] || [ ! -f "$report" ]; then
    plog "PIPELINE_RETRY: $mode dispatch rc=$rc (no report) → leave issue active and retry"
    return "$WORKER_UNAVAILABLE"
  fi
  parsePipelineReport "$report"
  [ -n "$acceptance_override" ] && REPORT_ACCEPTANCE="$acceptance_override"
  [ -n "$linear_override" ] && REPORT_LINEAR_POSTED="$linear_override"
  [ "$mode" = role ] && return 0
  if [ "$mode" = "solo" ]; then
    [ "$REPORT_NEXT_ACTION" = "NEEDS_DEBUG" ] && {
      # NEEDS_DEBUG is machine-actionable continuation, not human wait. Reuse the retryable exit so
      # the runner re-enqueues with backoff and does not write human-wait suppression state.
      plog "PIPELINE_RETRY: solo NEEDS_DEBUG → automatic retry"
      return "$WORKER_UNAVAILABLE"
    }
    [ "$REPORT_ACCEPTANCE" = "FAIL" ] && {
      plog "PIPELINE_STOP: solo acceptance FAIL → needs attention"
      return "$COMPLETION_UNVERIFIED"
    }
    [ "$REPORT_NEXT_ACTION" = "READY_FOR_REVIEW" ] || {
      plog "PIPELINE_STOP: solo '${REPORT_NEXT_ACTION:-<none>}' → stop (needs human)"
      return "$COMPLETION_UNVERIFIED"
    }
  fi
  if [ "$REPORT_HAS_PR" -eq 1 ]; then
    [ "$REPORT_ACCEPTANCE" = "PASS" ] || {
      plog "PIPELINE_STOP: $mode PR result lacks explicit Acceptance PASS → unverified"
      return "$COMPLETION_UNVERIFIED"
    }
    [ -n "$REPORT_LINEAR_POSTED" ] || {
      plog "PIPELINE_STOP: $mode PR result lacks Linear Report POSTED → completion was not reported"
      return "$COMPLETION_UNVERIFIED"
    }
    PIPELINE_NO_PR=0
  else
    PIPELINE_NO_PR=1
  fi
  return 0
}

# Unified role loop. The declarative graph is the only multi-role execution model; solo mode remains
# a single-worker lifecycle. The graph bounds debug back-edges and classifies all terminal outcomes.
run_graph_role_loop() {
  local issue="$1" state_file="$2" first_result="$3" run_id="$4"
  local target_repo="${WEBHOOK_TARGET_REPO:-${TARGET_REPO:-}}"
  local node role debug_spent
  IFS=$'\t' read -r node role debug_spent < <(
    node -e 'const r=JSON.parse(process.argv[1]); process.stdout.write([r.node||"",r.role||"",r.debugSpent??0].join("\t"))' "$first_result"
  )
  if [ -z "$node" ] || [ -z "$role" ]; then
    plog "PIPELINE_STOP: invalid structured graph entry '$first_result' → needs attention"
    return "$COMPLETION_UNVERIFIED"
  fi
  plog "PIPELINE_GRAPH: graph-driven role loop active (entry=$node state=$state_file)"

  PIPELINE_NO_PR=0
  GITHUB_REPORT=""
  local pipeline_acceptance="" pipeline_linear_posted=""
  unset PIPELINE_PINNED_WORKER
  local pipeline_start_ms; pipeline_start_ms="$(date +%s%3N 2>/dev/null || echo '')"
  local cb_no_progress=0 cb_last_fp=""

  # Delegation preflight (SOT-1574).
  local _delegation_preflight_enabled=1
  case "$(printf '%s' "${DELEGATION_PREFLIGHT:-1}" | tr '[:upper:]' '[:lower:]')" in
    0|false|no|off) _delegation_preflight_enabled=0 ;;
  esac
  if [ "$_delegation_preflight_enabled" -eq 0 ]; then
    plog "delegation preflight disabled by DELEGATION_PREFLIGHT; skipping"
  else
    set +e
    run_cli delegation-preflight "$issue" 2>>"$LOG_FILE" | while IFS= read -r _pf_line; do
      plog "$_pf_line"
    done
    set -e
  fi

  while :; do
    plog "── graph node: $node → role $role (issue $issue) ──"

    if [ ! -s "prompts/roles/$role.md" ]; then
      plog "PIPELINE_STOP: missing canonical prompt prompts/roles/$role.md"
      return "$COMPLETION_UNVERIFIED"
    fi

    # Circuit breaker (SOT-1560); the graph's debug-budget spend is the failure counter.
    if [ "$role" = "implementation" ]; then
      local cb_fp; cb_fp="$(_cb_fingerprint "${target_repo:-.}")"
      if [ -n "$cb_last_fp" ]; then
        if [ "$cb_fp" = "$cb_last_fp" ]; then cb_no_progress=$((cb_no_progress + 1)); else cb_no_progress=0; fi
      fi
      cb_last_fp="$cb_fp"
    fi
    local cb_out cb_rc
    set +e
    cb_out="$(CB_STARTED_AT_MS="$pipeline_start_ms" \
              CB_CONSECUTIVE_FAILURES="$debug_spent" \
              CB_NO_PROGRESS_CYCLES="$cb_no_progress" \
              run_breaker_cli 2>>"$LOG_FILE")"
    cb_rc=$?
    set -e
    if [ "$cb_rc" -eq 10 ]; then
      plog "PIPELINE_HALT: circuit breaker tripped at role=$role → $cb_out"
      run_cli move-on-hold "$issue" "$cb_out" >/dev/null 2>&1 || true
      return "$COMPLETION_UNVERIFIED"
    fi

    executeNode "$issue" "$role"
    finalizeRun "role" "$NODE_RC" "$NODE_REPORT" || return $?
    local report="$NODE_REPORT" winner="$NODE_WINNER"
    parsePipelineReport "$report"
    local na="$REPORT_NEXT_ACTION"
    plog "role=$role next_action='${na:-<none>}' report=$report"

    [ "$role" = "github" ] && GITHUB_REPORT="$report"
    [ "$role" = "linear-report" ] && pipeline_linear_posted="$REPORT_LINEAR_POSTED"

    # SOT-1555 pin — same as the serial task-check gate.
    if [ "$role" = "task-check" ] && printf '%s' "$na" | grep -q 'READY_FOR_REVIEW'; then
      if grep -qiE '^##[[:space:]]*Implementation:[[:space:]]*NOT_REQUIRED' "$report" 2>/dev/null; then
        if [ -n "$winner" ]; then
          export PIPELINE_PINNED_WORKER="$winner"
          plog "PIPELINE_PIN: task-check flagged implementation-not-required → pin all remaining roles to worker=$winner (no handoff)"
        else
          plog "PIPELINE_PIN: implementation-not-required flagged but winning worker unknown → not pinning"
        fi
      fi
    fi

    # Acceptance machine verdict (SOT-1558) — handed to the engine, which applies the same
    # FAIL-wins / PASS-unless-human-stop / fallback-to-Next-Action precedence as the serial gate.
    local acc="NONE"
    if [ "$role" = "acceptance" ]; then
      acc="$REPORT_ACCEPTANCE"
      pipeline_acceptance="$REPORT_ACCEPTANCE"
      [ -z "$acc" ] && acc="NONE"
      plog "role=acceptance machine_verdict='$([ "$acc" = "NONE" ] && echo '<none>' || echo "$acc")' next_action='${na:-<none>}'"
    fi

    local step step_rc
    set +e
    step="$(run_cli pipeline-graph advance --state "$state_file" --run-id "$run_id" --issue-id "$issue" --next-action "${na:-NONE}" --acceptance "$acc" 2>>"$LOG_FILE")"
    step_rc=$?
    set -e
    if [ "$step_rc" -ne 0 ] || [ -z "$step" ]; then
      plog "PIPELINE_STOP: graph transition failed (rc=$step_rc node=$node na='${na:-<none>}') → needs attention"
      return "$COMPLETION_UNVERIFIED"
    fi
    plog "PIPELINE_GRAPH: $step"
    {
      echo "# Pipeline Graph Run: $issue"
      echo
      echo "- Graph: ${PIPELINE_GRAPH_FILE:-config/pipeline_graph.json}"
      echo "- Node path: $(node -e 'const s=require(process.argv[1]); console.log([...(s.history||[]).map(x=>x.from), s.current].filter((x,i,a)=>i===0||x!==a[i-1]).join(" → "))' "$state_file" 2>/dev/null || true)"
      if [ -f "docs/ai/pipeline/discussion_$issue.md" ]; then
        grep -E '^- Rounds completed:|^- Outcome:' "docs/ai/pipeline/discussion_$issue.md" || true
      fi
    } > "docs/ai/pipeline/graph_run_summary.$issue.md"
    local step_kind step_target step_role next_spent
    IFS=$'\t' read -r step_kind step_target step_role next_spent < <(
      node -e 'const r=JSON.parse(process.argv[1]); process.stdout.write([r.kind||"",r.kind==="terminal"?(r.terminal||""):(r.node||""),r.role||"",r.debugSpent??0].join("\t"))' "$step"
    )
    case "$step_kind:$step_target" in
      terminal:done_no_pr)
        plog "PIPELINE_DONE: graph terminal done_no_pr for $issue → success no-op"
        PIPELINE_NO_PR=1
        return 0
        ;;
      terminal:done)
        break
        ;;
      terminal:stop)
        plog "PIPELINE_STOP: graph terminal stop at role=$role → needs attention"
        return "$COMPLETION_UNVERIFIED"
        ;;
      node:*)
        [ -n "$next_spent" ] && debug_spent="$next_spent"
        node="$step_target"
        role="$step_role"
        if [ -z "$node" ] || [ -z "$role" ]; then
          plog "PIPELINE_STOP: invalid structured graph step '$step' → needs attention"
          return "$COMPLETION_UNVERIFIED"
        fi
        ;;
      *)
        plog "PIPELINE_STOP: invalid structured graph step '$step' → needs attention"
        return "$COMPLETION_UNVERIFIED"
        ;;
    esac
  done

  if [ -n "$GITHUB_REPORT" ]; then
    finalizeRun "graph" 0 "$GITHUB_REPORT" "$pipeline_acceptance" "$pipeline_linear_posted" || return $?
  fi

  plog "PIPELINE_DONE: all graph roles completed for $issue (no_pr=$PIPELINE_NO_PR)"
  return 0
}

run_role_pipeline() {
  local issue="$1"
  local target_repo="${WEBHOOK_TARGET_REPO:-${TARGET_REPO:-}}"
  [ -n "$target_repo" ] && export TARGET_REPO="$target_repo"

  # Per-issue worker override (SOT-1459): a `workers: role=chain` directive in the Linear issue
  # description/comments reroutes roles for THIS issue only. resolve-worker-roles writes a merged
  # config and prints its path; point the whole pipeline's dispatcher at it via WORKER_ROLES_FILE.
  # Fail-open: empty output / error → keep the default config/worker_roles.json.
  local override_file
  override_file="$(run_cli resolve-worker-roles "$issue" 2>>"$LOG_FILE" || true)"
  if [ -n "$override_file" ] && [ -f "$override_file" ]; then
    export WORKER_ROLES_FILE="$override_file"
    plog "per-issue worker override active (WORKER_ROLES_FILE=$override_file)"
  fi

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
    echo "Use this issue as the primary target for this pipeline run."
  } > docs/ai/pipeline/context.md

  # SOT-1590: move the issue to In Progress the moment work starts — BEFORE dispatching task-check —
  # so a picked-up issue leaves Todo immediately instead of only after task-check finishes its
  # actionability check + 分解判断. Best-effort / fail-open (the helper skips terminal/already-started
  # and never throws); a Linear hiccup here must never block the role loop.
  run_cli set-issue-in-progress "$issue" >/dev/null 2>>"$LOG_FILE" || true
  plog "issue $issue → In Progress (pipeline start)"

  # SOT-2202: resolve issue directives, solo config, and graph environment flags once. The pure
  # resolver in executionPlan.ts is the single source of truth for precedence and explanation.
  local execution_plan execution_mode selected_graph solo_worker
  execution_plan="$(run_cli execution-plan "$issue" 2>>"$LOG_FILE" || true)"
  if [ -z "$execution_plan" ]; then
    plog "PIPELINE_STOP: execution plan could not be resolved"
    return "$COMPLETION_UNVERIFIED"
  fi
  execution_mode="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.mode||"")' "$execution_plan" 2>>"$LOG_FILE" || true)"
  selected_graph="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.graphPath||"")' "$execution_plan" 2>>"$LOG_FILE" || true)"
  solo_worker="$(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(p.soloWorker||"")' "$execution_plan" 2>>"$LOG_FILE" || true)"
  plog "EXECUTION_PLAN: $(node -e 'const p=JSON.parse(process.argv[1]); process.stdout.write(`mode=${p.mode} source=${p.source} reason=${p.reason}`)' "$execution_plan" 2>>"$LOG_FILE" || true)"
  if [ -n "$selected_graph" ]; then
    export PIPELINE_GRAPH_FILE="$selected_graph"
  fi

  # SOT-1591 SOLO MODE: if the worker-roles config sets `__solo__`, ONE AI runs the entire lifecycle in a
  # SINGLE dispatch — no per-role loop, no script handoff/gating in between. Query the resolved config
  # (WORKER_ROLES_FILE carries the per-issue merge; solo mode is preserved through it). Fail-open: empty
  # output → fall through to the normal per-role pipeline below.
  if [ "$execution_mode" = "solo" ] && [ -n "$solo_worker" ]; then
    plog "SOLO MODE: worker=$solo_worker runs the whole lifecycle in one dispatch (no per-role handoff)"
    PIPELINE_NO_PR=0
    local scap; scap="$(mktemp)"
    set +e
    bash scripts/ai/run_worker.sh solo 2>&1 | python3 -u -c "$_PIPE_TAG_FILTER" | tee -a "$LOG_FILE" "$scap"
    local src=${PIPESTATUS[0]}
    set -e
    local sdone sreport
    sdone="$(grep -oE 'WORKER_DISPATCH_DONE role=[^ ]+ worker=[^ ]+ report=[^ ]+' "$scap" 2>/dev/null | tail -1 || true)"
    sreport="$(printf '%s' "$sdone" | sed 's/.*report=//' || true)"
    rm -f "$scap"
    finalizeRun "solo" "$src" "$sreport" || return $?
    plog "PIPELINE_DONE: solo lifecycle completed for $issue (no_pr=$PIPELINE_NO_PR)"
    return 0
  fi

  # Every non-solo run uses the graph engine. Invalid graph configuration is a safe stop: silently
  # switching to a second implementation would make runtime behavior depend on a compatibility path.
  if [ "$execution_mode" = "graph" ]; then
    local graph_state="docs/ai/pipeline/graph_state.$issue.json"
    local graph_first="" graph_rc=0
    local graph_run_id="${RUN_ID:-${PIPELINE_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}}"
    local graph_resume=false
    [ -n "${RESUME_ISSUE:-}" ] && graph_resume=true
    if [ "$graph_resume" = true ] && [ -s "$graph_state" ]; then
      local checkpoint_run_id
      checkpoint_run_id="$(node -e 'const s=require(process.argv[1]); process.stdout.write(typeof s.runId==="string"?s.runId:"")' "$graph_state" 2>/dev/null || true)"
      [ -n "$checkpoint_run_id" ] && graph_run_id="$checkpoint_run_id"
    fi
    set +e
    graph_first="$(run_cli pipeline-graph open --state "$graph_state" --run-id "$graph_run_id" --issue-id "$issue" --resume "$graph_resume" 2>>"$LOG_FILE")"
    graph_rc=$?
    set -e
    if [ "$graph_rc" -eq 0 ] && [ -n "$graph_first" ]; then
      run_graph_role_loop "$issue" "$graph_state" "$graph_first" "$graph_run_id"
      return $?
    fi
    plog "PIPELINE_STOP: graph unavailable/invalid (rc=$graph_rc) → needs attention"
    return "$COMPLETION_UNVERIFIED"
  fi

  plog "PIPELINE_STOP: unsupported execution mode '$execution_mode'"
  return "$COMPLETION_UNVERIFIED"

}

TARGET_ISSUE="${RESUME_ISSUE:-${WEBHOOK_ISSUE_ID:-}}"
if [ -n "$TARGET_ISSUE" ]; then
  echo "== Auto Runner: script-driven role pipeline (issue $TARGET_ISSUE) =="
  echo "Start: ${TIMESTAMP}"
  echo "Log: ${LOG_FILE}"
  echo ""
  # NOTE (SOT loop-breaker fix): run_role_pipeline toggles `set -e` per role internally, and shell
  # options are global (not function-scoped), so errexit is re-enabled by the time the function returns.
  # A bare `run_role_pipeline "$TARGET_ISSUE"` would therefore abort the whole script the instant the
  # function returns a non-zero COMPLETION_UNVERIFIED (the common "needs human" stop), skipping the
  # ensure-issue-reviewed loop-breaker below and leaving the issue stranded In Progress. Capturing the
  # status via `||` makes this a tested command, so errexit never fires here regardless of option state.
  set +e
  EXIT_CODE=0
  run_role_pipeline "$TARGET_ISSUE" || EXIT_CODE=$?
  set -e
  # SOT-1550: emit a machine-parseable completion contract for the pipeline path (the legacy path
  # already does this). A successful no-PR PLAN/REVIEW terminal → COMPLETED_NO_PR so the runner
  # classifies it as a terminal success (COMPLETED_NO_PR) instead of COMPLETION_UNVERIFIED, keeping it
  # out of the reaper re-injection bucket. Any other clean exit stays plain COMPLETED (unchanged).
  if [ "$EXIT_CODE" -eq 0 ]; then
    if [ "${PIPELINE_NO_PR:-0}" -eq 1 ]; then
      echo "COMPLETION_CONTRACT: COMPLETED_NO_PR"
    else
      echo "COMPLETION_CONTRACT: COMPLETED"
    fi
  fi
  # Loop-breaker (SOT-1438): a finished run must not leave the issue Todo/In Progress, or the
  # webhook-reaper re-enqueues it forever as a "stranded active issue" and the pipeline loops. If the
  # pipeline did not advance it (e.g. PLAN / blocked / needs-human), move it to In Review. Idempotent
  # / best-effort: no-op when already In Review/terminal; never changes the run's exit code.
  # SOT-1584: EXCEPT when the run stopped because every worker was TRANSIENTLY non-responsive
  # (EXIT_CODE=WORKER_UNAVAILABLE=71). The pipeline did NOT complete a full pass — it aborted on
  # transient worker unavailability — so moving to In Review would be misleading and would strand
  # ready work. Leave the issue active; the runner re-enqueues it with backoff to retry on recovery.
  if [ "$EXIT_CODE" -eq "$WORKER_UNAVAILABLE" ]; then
    echo "[pipeline] RETRYABLE (71): worker unavailable or NEEDS_DEBUG → skip ensure-issue-reviewed, leave issue active for retry"
  else
    # A clean completion can still leave the issue active when the worker's best-effort Linear sync
    # did not run. Preserve the loop-breaker transition, but do not misreport that successful run as
    # "completion not reached" (SOT-1732).
    if [ "$EXIT_CODE" -eq 0 ] && [ "${PIPELINE_NO_PR:-0}" -eq 1 ]; then
      run_cli ensure-issue-reviewed "$TARGET_ISSUE" completed-no-pr >/dev/null 2>&1 || true
    elif [ "$EXIT_CODE" -eq 0 ]; then
      run_cli ensure-issue-reviewed "$TARGET_ISSUE" completed >/dev/null 2>&1 || true
    else
      run_cli ensure-issue-reviewed "$TARGET_ISSUE" incomplete >/dev/null 2>&1 || true
    fi
  fi
  echo ""
  echo "== Finished pipeline: $(date +"%Y%m%d_%H%M%S") (exit: ${EXIT_CODE}) =="
  exit "$EXIT_CODE"
fi

echo "Error: run_auto.sh requires --resume <issue> or WEBHOOK_ISSUE_ID." >&2
exit 1
