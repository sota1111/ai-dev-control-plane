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
# アーカイブは親150/子50を維持する archive_linear_issues.sh に委譲する（各カテゴリ古い順・作業中除外）。
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
# WEBHOOK_ISSUE_ID を注入するため、autonomous 経路は必ずこのパイプラインを通る。issue 未指定の手動起動
# （キュー走査）や `PIPELINE_MODE=0` のときは、後方互換のためレガシーの単一オーケストレータ起動へ退避する。
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
    echo "Process ONLY this issue. Do not select or process other Linear issues."
  } > docs/ai/pipeline/context.md

  # SOT-1590: move the issue to In Progress the moment work starts — BEFORE dispatching task-check —
  # so a picked-up issue leaves Todo immediately instead of only after task-check finishes its
  # actionability check + 分解判断. Best-effort / fail-open (the helper skips terminal/already-started
  # and never throws); a Linear hiccup here must never block the role loop.
  run_cli set-issue-in-progress "$issue" >/dev/null 2>>"$LOG_FILE" || true
  plog "issue $issue → In Progress (pipeline start)"

  # SOT-1591 SOLO MODE: if the worker-roles config sets `__solo__`, ONE AI runs the entire lifecycle in a
  # SINGLE dispatch — no per-role loop, no script handoff/gating in between. Query the resolved config
  # (WORKER_ROLES_FILE carries the per-issue merge; solo mode is preserved through it). Fail-open: empty
  # output → fall through to the normal per-role pipeline below.
  local solo_worker
  solo_worker="$(run_cli solo-worker 2>>"$LOG_FILE" || true)"
  if [ -n "$solo_worker" ]; then
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
    if [ "$src" -ne 0 ] || [ -z "$sreport" ] || [ ! -f "$sreport" ]; then
      # rc=75 = solo worker transiently non-responsive (usage limit / crash): leave active, retry later
      # (mirrors the per-role dispatcher-exhaustion handling). Only reached after the solo handoff chain is exhausted.
      if [ "$src" -eq 75 ]; then
        plog "PIPELINE_RETRY: solo worker '$solo_worker' transiently non-responsive (rc=75) → leave active, retry when it recovers"
        return "$WORKER_UNAVAILABLE"
      fi
      plog "PIPELINE_STOP: solo dispatch rc=$src (no report) → needs attention"
      return "$COMPLETION_UNVERIFIED"
    fi
    # Solo verdict: acceptance FAIL or a human-stop Next Action → needs attention; else complete.
    local sacc sna
    sacc="$(grep -ioE '^##[[:space:]]*Acceptance:[[:space:]]*(PASS|FAIL)' "$sreport" 2>/dev/null | grep -ioE '(PASS|FAIL)' | tail -1 | tr '[:lower:]' '[:upper:]' || true)"
    sna="$(awk '/[Nn]ext[[:space:]]*[Aa]ction/{cap=1; buf=""} cap{buf=buf"\n"$0} END{print buf}' "$sreport" 2>/dev/null | grep -oiE 'READY_FOR_REVIEW|NEEDS_DEBUG|NEEDS_USER_INPUT|BLOCKED' | head -n1 | tr '[:lower:]' '[:upper:]' || true)"
    plog "SOLO result: acceptance='${sacc:-<none>}' next_action='${sna:-<none>}' report=$sreport"
    if [ "$sacc" = "FAIL" ]; then
      plog "PIPELINE_STOP: solo acceptance FAIL → needs attention"; return "$COMPLETION_UNVERIFIED"
    fi
    case "$sna" in
      *READY_FOR_REVIEW*) ;;  # complete
      *) plog "PIPELINE_STOP: solo '${sna:-<none>}' → stop (needs human)"; return "$COMPLETION_UNVERIFIED" ;;
    esac
    # PR detection (reuse the github-role heuristic): no PR reference in the solo report → no-PR terminal
    # (PLAN/REVIEW/decomposition/no-op) → In Review; a PR reference → normal COMPLETED.
    if grep -qiE 'pull/[0-9]+|PR[ :*]*#[0-9]+' "$sreport" 2>/dev/null; then PIPELINE_NO_PR=0; else PIPELINE_NO_PR=1; fi
    plog "PIPELINE_DONE: solo lifecycle completed for $issue (no_pr=$PIPELINE_NO_PR)"
    return 0
  fi

  # SOT-1553: task-check now folds in the decomposition work (check + 分解判断 + child-issue registration)
  # so it runs as a single worker dispatch — decomposition is no longer a separate step with a script in
  # between. The `decomposition` role remains a valid role for manual/override dispatch, just not part of
  # the default sequential pipeline.
  local roles=(task-check implementation verification acceptance github linear-report)
  local n=${#roles[@]}
  local impl_index=1 verify_index=2
  local i=0 debug_cycles=0
  local MAX_DEBUG_CYCLES="${PIPELINE_MAX_DEBUG_CYCLES:-2}"

  # SOT-1560: circuit-breaker baseline. `debug_cycles` doubles as the consecutive-failure counter (the
  # breaker generalizes PIPELINE_MAX_DEBUG_CYCLES). no-progress is measured across implementation cycles
  # via the working-repo git fingerprint. All knobs ship DISABLED (config/circuit_breaker.json all-zero)
  # → strict no-op, so this guard changes nothing until a knob is enabled deliberately.
  local pipeline_start_ms; pipeline_start_ms="$(date +%s%3N 2>/dev/null || echo '')"
  local cb_no_progress=0 cb_last_fp=""

  # SOT-1550: track whether this pipeline finished as a PLAN/REVIEW no-PR terminal so the caller can
  # emit COMPLETION_CONTRACT: COMPLETED_NO_PR (a real terminal success, distinct from UNVERIFIED).
  # Global (no `local`) so it is visible to the caller after run_role_pipeline returns. Default 0 =
  # unknown/PR-producing → caller emits plain COMPLETED (unchanged behavior).
  PIPELINE_NO_PR=0
  GITHUB_REPORT=""

  # SOT-1555: clear any pin from a previous run so it never leaks. task-check may set
  # PIPELINE_PINNED_WORKER (implementation-not-required → keep the whole lifecycle on one AI).
  unset PIPELINE_PINNED_WORKER

  # SOT-1574: delegation / cost preflight — before spending any role, emit ONE human-readable block
  # showing which worker handles each role (summarizing WORKER_ROLES_FILE / per-issue override) plus a
  # QUALITATIVE usage estimate (cooldown/auth state, Claude-primary role count, PIPELINE_MAX_DEBUG_CYCLES
  # loop bound). No dollar figures (real spend is not obtainable). Best-effort / fail-open — never blocks
  # the role loop. Disable with DELEGATION_PREFLIGHT=0/false/no/off.
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

  while [ "$i" -lt "$n" ]; do
    local role="${roles[$i]}"
    plog "── role[$i]: $role (issue $issue) ──"

    if [ ! -s "prompts/roles/$role.md" ]; then
      plog "PIPELINE_STOP: missing canonical prompt prompts/roles/$role.md"
      return "$COMPLETION_UNVERIFIED"
    fi

    # SOT-1560: circuit-breaker guard — consult the stop-condition breaker BEFORE spending another role,
    # so a runaway loop is caught before it burns more tokens. Track no-progress across implementation
    # cycles (git diff/commit fingerprint at each implementation entry). On trip: stop safely, notify
    # Linear, and park the issue in On Hold so recover/reaper stop re-running it (kill the re-run loop).
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
              CB_CONSECUTIVE_FAILURES="$debug_cycles" \
              CB_NO_PROGRESS_CYCLES="$cb_no_progress" \
              run_breaker_cli 2>>"$LOG_FILE")"
    cb_rc=$?
    set -e
    if [ "$cb_rc" -eq 10 ]; then
      plog "PIPELINE_HALT: circuit breaker tripped at role=$role → $cb_out"
      run_cli move-on-hold "$issue" "$cb_out" >/dev/null 2>&1 || true
      return "$COMPLETION_UNVERIFIED"
    fi

    # Run the dispatcher through the tag/ANSI filter; show on the terminal, append to the log, AND
    # capture output to parse the winning report path. The filter strips ANSI color escapes and tags
    # each line with the worker actor ([codex]/[agy]/[claude]) so Discord/log lines read cleanly.
    # PIPESTATUS[0] is the dispatcher's exit code (run_worker.sh), unaffected by the filter/tee.
    local cap; cap="$(mktemp)"
    set +e
    bash scripts/ai/run_worker.sh "$role" 2>&1 | python3 -u -c "$_PIPE_TAG_FILTER" | tee -a "$LOG_FILE" "$cap"
    local rc=${PIPESTATUS[0]}
    set -e

    local dispatch_done; dispatch_done="$(grep -oE 'WORKER_DISPATCH_DONE role=[^ ]+ worker=[^ ]+ report=[^ ]+' "$cap" 2>/dev/null | tail -1 || true)"
    local report; report="$(printf '%s' "$dispatch_done" | sed 's/.*report=//' || true)"
    local winner; winner="$(printf '%s' "$dispatch_done" | sed -E 's/.*worker=([^ ]+).*/\1/' || true)"
    rm -f "$cap"

    if [ "$rc" -ne 0 ] || [ -z "$report" ] || [ ! -f "$report" ]; then
      # SOT-1584: dispatcher exit 75 = WORKER_DISPATCH_EXHAUSTED — every worker in the chain was
      # TRANSIENTLY non-responsive (usage cooldown / auth crash / disabled). This is not a genuine
      # completion failure: retry later when a worker recovers instead of moving the issue to In Review.
      # Any OTHER non-zero rc or a missing report is treated as the usual needs-attention stop.
      if [ "$rc" -eq 75 ]; then
        plog "PIPELINE_RETRY: role=$role dispatcher rc=75 (all workers transiently non-responsive) → leave issue active, retry when a worker recovers"
        return "$WORKER_UNAVAILABLE"
      fi
      plog "PIPELINE_STOP: role=$role dispatcher rc=$rc (no report) → needs attention"
      return "$COMPLETION_UNVERIFIED"
    fi

    # Parse the role's verdict token from the report. Workers emit it either INLINE
    # (`## Next Action: READY_FOR_REVIEW`) OR on the line AFTER the header. The old parser only read the
    # line after the header, so an inline token parsed as <none> and wrongly stopped the pipeline (which,
    # combined with the errexit leak below, stranded the issue In Progress). Read from the LAST
    # `## Next Action` header to EOF (awk resets the buffer at each header) and pull the first known
    # verdict token, case-insensitively, normalized to upper case.
    local na; na="$(awk '/[Nn]ext[[:space:]]*[Aa]ction/{cap=1; buf=""} cap{buf=buf"\n"$0} END{print buf}' "$report" 2>/dev/null | grep -oiE 'READY_FOR_REVIEW|NEEDS_DEBUG|NEEDS_USER_INPUT|BLOCKED' | head -n1 | tr '[:lower:]' '[:upper:]' || true)"
    plog "role=$role next_action='${na:-<none>}' report=$report"

    # SOT-1550: remember the github role's report so we can tell (after all roles complete) whether a
    # PR was actually created — PLAN/REVIEW tasks skip the PR and terminate at In Review (no-PR).
    [ "$role" = "github" ] && GITHUB_REPORT="$report"

    case "$role" in
      task-check)
        case "$na" in
          *READY_FOR_REVIEW*)
            # SOT-1555: if task-check flagged the issue implementation-not-required (DOC / REVIEW /
            # QUESTION / SECURITY-scan / trivial), pin every subsequent role to the worker that just
            # handled task-check, so the whole lifecycle is completed by ONE AI with no cross-worker
            # handoff. run_worker.sh moves this worker to the front of each role's chain (rest kept as
            # fallback → fail-open). Absent flag → REQUIRED → no pin → unchanged multi-worker behavior.
            if grep -qiE '^##[[:space:]]*Implementation:[[:space:]]*NOT_REQUIRED' "$report" 2>/dev/null; then
              if [ -n "$winner" ]; then
                export PIPELINE_PINNED_WORKER="$winner"
                plog "PIPELINE_PIN: task-check flagged implementation-not-required → pin all remaining roles to worker=$winner (no handoff)"
              else
                plog "PIPELINE_PIN: implementation-not-required flagged but winning worker unknown → not pinning"
              fi
            fi
            ;;  # actionable, no decomposition → proceed to implementation
          # SOT-1550/1553: task-check now also performs decomposition. A non-READY result means either
          # not-actionable (already terminal / In Review / needs-human) OR the issue was decomposed into
          # child issues (which run as their own pipelines). Both stop the parent pipeline WITHOUT a PR —
          # a successful no-op, so mark it a no-PR terminal (classified COMPLETED_NO_PR, not UNVERIFIED).
          *) plog "PIPELINE_DONE: task-check not-actionable or decomposed ('$na') → success no-op"; PIPELINE_NO_PR=1; return 0 ;;
        esac
        ;;
      verification)
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
      acceptance)
        # SOT-1558: the acceptance verdict is decided by a MACHINE-READABLE line — `## Acceptance: PASS`
        # or `## Acceptance: FAIL` (criterion-level [x]/[ ] above it). run_auto.sh reads that line
        # directly instead of trusting an ambiguous natural-language completion claim. Precedence:
        #   FAIL      → loop back to implementation (bounded), regardless of Next Action.
        #   PASS      → proceed (Next Action must also not be a stop/blocker).
        #   (absent)  → fall back to the Next Action verdict (backward compatible; logged as a warning).
        local acc_verdict; acc_verdict="$(grep -ioE '^##[[:space:]]*Acceptance:[[:space:]]*(PASS|FAIL)' "$report" 2>/dev/null | grep -ioE '(PASS|FAIL)' | tail -1 | tr '[:lower:]' '[:upper:]' || true)"
        plog "role=acceptance machine_verdict='${acc_verdict:-<none>}' next_action='${na:-<none>}'"
        if [ "$acc_verdict" = "FAIL" ]; then
          if [ "$debug_cycles" -lt "$MAX_DEBUG_CYCLES" ]; then
            debug_cycles=$((debug_cycles + 1))
            plog "PIPELINE_LOOP: acceptance ## Acceptance: FAIL → re-run implementation (cycle $debug_cycles/$MAX_DEBUG_CYCLES)"
            i="$impl_index"; continue
          fi
          plog "PIPELINE_STOP: acceptance ## Acceptance: FAIL after $MAX_DEBUG_CYCLES cycles → needs attention"
          return "$COMPLETION_UNVERIFIED"
        fi
        if [ "$acc_verdict" = "PASS" ]; then
          case "$na" in
            *NEEDS_USER_INPUT*|*BLOCKED*)
              plog "PIPELINE_STOP: acceptance PASS but '$na' → stop (needs human)"; return "$COMPLETION_UNVERIFIED" ;;
            *) ;;  # PASS and not a human-stop → proceed
          esac
        else
          # No machine-readable verdict — fall back to Next Action (backward compatible), but warn: the
          # acceptance role is expected to emit `## Acceptance: PASS|FAIL` (prompts/roles/acceptance.md).
          plog "PIPELINE_WARN: acceptance report has no '## Acceptance: PASS|FAIL' line → falling back to Next Action"
          case "$na" in
            *READY_FOR_REVIEW*) ;;  # passed → proceed
            *NEEDS_DEBUG*)
              if [ "$debug_cycles" -lt "$MAX_DEBUG_CYCLES" ]; then
                debug_cycles=$((debug_cycles + 1))
                plog "PIPELINE_LOOP: acceptance NEEDS_DEBUG → re-run implementation (cycle $debug_cycles/$MAX_DEBUG_CYCLES)"
                i="$impl_index"; continue
              fi
              plog "PIPELINE_STOP: acceptance still NEEDS_DEBUG after $MAX_DEBUG_CYCLES cycles → needs attention"
              return "$COMPLETION_UNVERIFIED"
              ;;
            *) plog "PIPELINE_STOP: acceptance '$na' → stop (needs human)"; return "$COMPLETION_UNVERIFIED" ;;
          esac
        fi
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

  # SOT-1550: the full pipeline ran. Decide whether it produced a PR. The github role records the PR
  # number/URL in its report (e.g. "PR: **#182**" / ".../pull/182"); PLAN/REVIEW tasks skip PR
  # creation, so a github report with no PR reference means this was a no-PR terminal (→ In Review).
  # Fail-safe: if we can't read the github report, leave PIPELINE_NO_PR=0 (emit plain COMPLETED).
  if [ -n "$GITHUB_REPORT" ] && [ -f "$GITHUB_REPORT" ]; then
    if grep -qiE 'pull/[0-9]+|PR[ :*]*#[0-9]+' "$GITHUB_REPORT" 2>/dev/null; then
      PIPELINE_NO_PR=0  # a PR was created/merged
    else
      PIPELINE_NO_PR=1  # no PR reference → PLAN/REVIEW no-PR terminal
    fi
  fi

  plog "PIPELINE_DONE: all roles completed for $issue (no_pr=$PIPELINE_NO_PR)"
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
    echo "[pipeline] WORKER_UNAVAILABLE (71): all workers transiently non-responsive → skip ensure-issue-reviewed, leave issue active for retry"
  else
    run_cli ensure-issue-reviewed "$TARGET_ISSUE" >/dev/null 2>&1 || true
  fi
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
