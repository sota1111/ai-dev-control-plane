#!/usr/bin/env bash
# バックグラウンドスケジューラー
#
# 動作モード:
#   LINEAR_API_KEY が設定されている場合:
#     CHECK_INTERVAL 秒ごとに Linear の Todo / In Progress の Issue が残っているか確認し、
#     1件でも存在すれば run_auto.sh を実行する。
#
#   LINEAR_API_KEY が未設定の場合:
#     フォールバックとして INTERVAL 秒ごとに無条件で run_auto.sh を実行する。
#
# 環境変数:
#   LINEAR_API_KEY   Linear Personal API Token（Settings > API > Personal API keys）
#   CHECK_INTERVAL   Linear ポーリング間隔（秒, デフォルト: 60）
#   INTERVAL         フォールバック用の実行間隔（秒, デフォルト: 3600）

set -euo pipefail

cd "$(dirname "$0")/../.."

# プロジェクトルートの .env を自動読み込み（既存の環境変数は上書きしない）
if [ -f ".env" ]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line//[[:space:]]/}" ]] && continue
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      _key="${BASH_REMATCH[1]}"
      _val="${BASH_REMATCH[2]}"
      _val="${_val%\"}" ; _val="${_val#\"}"
      _val="${_val%\'}" ; _val="${_val#\'}"
      [[ -z "${!_key+x}" ]] && export "$_key=$_val"
    fi
  done < ".env"
  unset _key _val
fi

INTERVAL=${INTERVAL:-3600}
CHECK_INTERVAL=${CHECK_INTERVAL:-60}
LOG_DIR="docs/ai/auto_logs"
AUTO_RUNNER_LOG="${LOG_DIR}/auto_runner.log"
SCHEDULER_LOG="${LOG_DIR}/scheduler.log"
LOCK_FILE="${LOG_DIR}/runner.lock"
STALE_LOCK_SECONDS=1800  # 30 minutes (matches runner.js STALE_LOCK_MS)
SKIPPED_LOCKED=75
PID_FILE="/tmp/l-concierge-scheduler.pid"
LINEAR_STATE_FILE="${LOG_DIR}/linear_state.txt"
LINEAR_API_URL="https://api.linear.app/graphql"

mkdir -p "$LOG_DIR"

WEBHOOK_MODE=${WEBHOOK_MODE:-false}

# --- webhook モード ---
# WEBHOOK_MODE=true の場合、ポーリングループを完全にスキップして終了する。
# Webhook サーバー（src/webhook-server.js）が起動時のトリガーを担う。
if [[ "${1:-}" != "stop" ]] && [[ "${1:-}" != "status" ]] && \
   [[ "${1:-}" != "--watch" ]] && [[ "${1:-}" != "--foreground" ]] && \
   [[ "$WEBHOOK_MODE" == "true" ]]; then
  echo "WEBHOOK_MODE=true: ポーリングスケジューラーは無効化されています。"
  echo "Webhook サーバーを起動してください: npm run start:webhook"
  exit 0
fi

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] [SCHEDULER] $*"
  echo "$msg" >> "$AUTO_RUNNER_LOG"
  echo "$msg" >> "$SCHEDULER_LOG"
}

# 共通ロック取得: 成功=0, 失敗=1
_acquire_lock() {
  mkdir -p "$LOG_DIR"

  if [ ! -f "$LOCK_FILE" ]; then
    echo "$$:$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK_FILE"
    log "LOCK acquired (pid=$$)"
    return 0
  fi

  local content pid timestamp_str
  content=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  pid=$(echo "$content" | cut -d: -f1)
  timestamp_str=$(echo "$content" | cut -d: -f2-)

  local is_dead=false
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    is_dead=true
  fi

  local is_stale=false
  if [ -n "$timestamp_str" ]; then
    local lock_epoch now_epoch age
    lock_epoch=$(date -u -d "$timestamp_str" +%s 2>/dev/null || echo 0)
    now_epoch=$(date -u +%s)
    age=$((now_epoch - lock_epoch))
    if [ "$age" -gt "$STALE_LOCK_SECONDS" ]; then
      is_stale=true
    fi
  fi

  if [ "$is_dead" = "true" ] || [ "$is_stale" = "true" ]; then
    local reason="stale"
    [ "$is_dead" = "true" ] && reason="dead process (pid=${pid})"
    log "LOCK removing ${reason} lock"
    rm -f "$LOCK_FILE"
    echo "$$:$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK_FILE"
    log "LOCK acquired after ${reason} removal (pid=$$)"
    return 0
  fi

  log "SKIPPED_LOCKED: lock held by pid=${pid}"
  return 1
}

# 共通ロック解放
_release_lock() {
  if [ -f "$LOCK_FILE" ]; then
    local content pid
    content=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
    pid=$(echo "$content" | cut -d: -f1)
    if [ "$pid" = "$$" ]; then
      rm -f "$LOCK_FILE"
      log "LOCK released (pid=$$)"
    fi
  fi
}

# Linear に Todo / In Progress の Issue が1件でも存在すれば 0、なければ 1 を返す。
linear_has_updates() {
  if [ -z "${LINEAR_API_KEY:-}" ]; then
    return 2  # API key not set
  fi

  local query
  query='{"query":"{ issues(filter: { state: { type: { in: [\"unstarted\",\"started\"] } } }, first: 1) { nodes { id title } } }"}'

  local response
  response=$(curl -sf -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: ${LINEAR_API_KEY}" \
    --data "$query" \
    "$LINEAR_API_URL" 2>/dev/null) || {
    log "Linear API request failed"
    return 1
  }

  local count
  count=$(echo "$response" | jq '.data.issues.nodes | length' 2>/dev/null)

  if [ -z "$count" ]; then
    log "Linear API returned unexpected response"
    return 1
  fi

  if [ "$count" -gt 0 ]; then
    local title
    title=$(echo "$response" | jq -r '.data.issues.nodes[0].title // ""' 2>/dev/null)
    log "Active issues found (Todo/In Progress) — triggering run. First: \"${title}\""
    return 0
  fi

  return 1  # no active issues
}

# セッションリミットのリセット時刻を解析し、リセット+10分後の epoch 秒を返す
# 引数: run_auto.sh の出力テキスト
# 例: "You've hit your session limit · resets 3:30pm (UTC)"
# 例: "You've hit your session limit · resets 6pm (UTC)"
_parse_session_reset_epoch() {
  local output="$1"
  local reset_str
  reset_str=$(echo "$output" | grep -oiP "(?<=resets )[0-9]+(:[0-9]+)?(am|pm)?(?= \(UTC\))" | head -1) || true
  [ -z "$reset_str" ] && return 1

  local hour min=0 ampm=''
  if [[ "$reset_str" =~ ^([0-9]+):([0-9]+)(am|pm)$ ]]; then
    hour="${BASH_REMATCH[1]}"; min="${BASH_REMATCH[2]}"; ampm="${BASH_REMATCH[3]}"
  elif [[ "$reset_str" =~ ^([0-9]+):([0-9]+)$ ]]; then
    hour="${BASH_REMATCH[1]}"; min="${BASH_REMATCH[2]}"
  elif [[ "$reset_str" =~ ^([0-9]+)(am|pm)$ ]]; then
    hour="${BASH_REMATCH[1]}"; ampm="${BASH_REMATCH[2]}"
  elif [[ "$reset_str" =~ ^([0-9]+)$ ]]; then
    hour="${BASH_REMATCH[1]}"
  else
    return 1
  fi

  if [[ "$ampm" == "pm" ]] && [[ "$hour" -ne 12 ]]; then hour=$((hour + 12)); fi
  if [[ "$ampm" == "am" ]] && [[ "$hour" -eq 12 ]]; then hour=0; fi

  local reset_epoch
  reset_epoch=$(date -u -d "today $(printf '%02d:%02d:00' "$hour" "$min") UTC" +%s 2>/dev/null) || return 1
  local target=$((reset_epoch + 600))   # +10 分
  local now_epoch; now_epoch=$(date -u +%s)
  if [[ "$target" -le "$now_epoch" ]]; then target=$((target + 86400)); fi
  echo "$target"
}

# AIセッション制限時にLinearへ通知（Codex経由）
_notify_via_codex() {
  local next_run_epoch="$1"
  if [ -z "${LINEAR_API_KEY:-}" ]; then
    log "Linear API key not set, skipping usage limit notification"
    return 0
  fi

  local next_run_jst
  next_run_jst=$(date -u -d "@$((next_run_epoch + 32400))" '+%Y-%m-%d %H:%M')
  local comment_body="usage-limit: Next auto run: ${next_run_jst} JST"

  log "Notifying usage limit via Codex: ${comment_body}"

  local prompt
  prompt="You are a Linear notification agent. Your only task is to post a usage-limit notification to Linear.

Environment: LINEAR_API_KEY is set in the environment.
Linear GraphQL API endpoint: https://api.linear.app/graphql
Authorization header: use the value of LINEAR_API_KEY directly (no 'Bearer' prefix needed).

Steps to complete:
1. Fetch all issues in 'unstarted' or 'started' state (first: 50).
   Query: { issues(filter: { state: { type: { in: [\"unstarted\",\"started\"] } } }, first: 50) { nodes { id labelIds } } }

2. Ensure the label 'usage-limit' exists. Fetch all labels first:
   { issueLabels(first: 50) { nodes { id name } } }
   If not found, get the first team ID and create the label:
   mutation { issueLabelCreate(input: { name: \"usage-limit\", color: \"#FF6B6B\", teamId: \"<team_id>\" }) { issueLabel { id } } }

3. For each active issue, post the comment:
   mutation { commentCreate(input: { issueId: \"<id>\", body: \"${comment_body}\" }) { success } }

4. For each active issue, update labels by APPENDING the usage-limit label (do not drop existing labels):
   mutation { issueUpdate(id: \"<id>\", input: { labelIds: [<existing_label_ids_plus_usage_limit_id>] }) { success } }

Use curl or Python to make the API calls. Complete all steps and exit 0 on success."

  if timeout 120 codex --sandbox danger-full-access exec "${prompt}" >> "$SCHEDULER_LOG" 2>&1; then
    log "Usage limit notification sent via Codex"
  else
    log "Codex notification failed, falling back to direct API"
    _notify_usage_limit_to_linear "$next_run_epoch"
  fi
}

# AIセッション制限時にLinearへ通知（コメント投稿とラベル付与）
_notify_usage_limit_to_linear() {
  local next_run_epoch="$1"
  if [ -z "${LINEAR_API_KEY:-}" ]; then
    log "Linear API key not set, skipping usage limit notification"
    return 0
  fi

  local next_run_jst
  next_run_jst=$(date -u -d "@$((next_run_epoch + 32400))" '+%Y-%m-%d %H:%M')
  local comment_body="usage-limit: Next auto run: ${next_run_jst} JST"

  # 1. usage-limit ラベルの ID を取得（なければ作成）
  local query_labels='{"query":"{ issueLabels(first: 50) { nodes { id name } } }"}'
  local resp_labels
  resp_labels=$(curl -sf -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: ${LINEAR_API_KEY}" \
    --data "$query_labels" \
    "$LINEAR_API_URL" 2>/dev/null) || true
  
  local label_id
  label_id=$(echo "$resp_labels" | jq -r '.data.issueLabels.nodes[] | select(.name == "usage-limit") | .id' 2>/dev/null | head -1) || true

  if [ -z "$label_id" ] || [ "$label_id" == "null" ]; then
    log "Label 'usage-limit' not found, creating..."
    local query_team='{"query":"{ teams(first: 1) { nodes { id } } }"}'
    local resp_team
    resp_team=$(curl -sf -X POST \
      -H "Content-Type: application/json" \
      -H "Authorization: ${LINEAR_API_KEY}" \
      --data "$query_team" \
      "$LINEAR_API_URL" 2>/dev/null) || true
    local team_id
    team_id=$(echo "$resp_team" | jq -r '.data.teams.nodes[0].id' 2>/dev/null) || true
    
    if [ -n "$team_id" ] && [ "$team_id" != "null" ]; then
      local mutation_label
      mutation_label=$(printf '{"query":"mutation { issueLabelCreate(input: { name: \\"usage-limit\\", color: \\"#FF6B6B\\", teamId: \\"%s\\" }) { issueLabel { id } } }"}' "$team_id")
      local resp_label_create
      resp_label_create=$(curl -sf -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: ${LINEAR_API_KEY}" \
        --data "$mutation_label" \
        "$LINEAR_API_URL" 2>/dev/null) || true
      label_id=$(echo "$resp_label_create" | jq -r '.data.issueLabelCreate.issueLabel.id' 2>/dev/null) || true
    fi
  fi

  # 2. アクティブな Issue を取得して通知
  local query_issues='{"query":"{ issues(filter: { state: { type: { in: [\"unstarted\",\"started\"] } } }, first: 50) { nodes { id } } }"}'
  local resp_issues
  resp_issues=$(curl -sf -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: ${LINEAR_API_KEY}" \
    --data "$query_issues" \
    "$LINEAR_API_URL" 2>/dev/null) || true
  
  local issue_ids
  issue_ids=$(echo "$resp_issues" | jq -r '.data.issues.nodes[].id' 2>/dev/null) || true

  for issue_id in $issue_ids; do
    [ -z "$issue_id" ] || [ "$issue_id" == "null" ] && continue
    log "Notifying usage limit for issue: ${issue_id}"
    
    # a. コメント投稿
    local mutation_comment
    mutation_comment=$(printf '{"query":"mutation { commentCreate(input: { issueId: \\"%s\\", body: \\"%s\\" }) { success } }"}' "$issue_id" "$comment_body")
    curl -sf -X POST \
      -H "Content-Type: application/json" \
      -H "Authorization: ${LINEAR_API_KEY}" \
      --data "$mutation_comment" \
      "$LINEAR_API_URL" >/dev/null 2>&1 || true

    # b. ラベル付与
    if [ -n "$label_id" ] && [ "$label_id" != "null" ]; then
      local mutation_update
      mutation_update=$(printf '{"query":"mutation { issueUpdate(id: \\"%s\\", input: { labelIds: [\\"%s\\"] }) { success } }"}' "$issue_id" "$label_id")
      curl -sf -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: ${LINEAR_API_KEY}" \
        --data "$mutation_update" \
        "$LINEAR_API_URL" >/dev/null 2>&1 || true
    fi
  done

  log "Usage limit notification process completed"
  return 0
}

# タスク完了時にLinearのusage-limitラベルを除去する
_remove_usage_limit_label() {
  if [ -z "${LINEAR_API_KEY:-}" ]; then
    log "Linear API key not set, skipping usage-limit label removal"
    return 0
  fi

  # 1. usage-limit ラベルの ID を取得
  local query_labels='{"query":"{ issueLabels(first: 50) { nodes { id name } } }"}'
  local resp_labels
  resp_labels=$(curl -sf -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: ${LINEAR_API_KEY}" \
    --data "$query_labels" \
    "$LINEAR_API_URL" 2>/dev/null) || true

  local label_id
  label_id=$(echo "$resp_labels" | jq -r '.data.issueLabels.nodes[] | select(.name == "usage-limit") | .id' 2>/dev/null | head -1) || true

  if [ -z "$label_id" ] || [ "$label_id" == "null" ]; then
    log "Label 'usage-limit' not found, nothing to remove"
    return 0
  fi

  # 2. usage-limit ラベルを持つ Issue を取得
  local query_issues
  query_issues=$(printf '{"query":"{ issues(filter: { labels: { id: { eq: \"%s\" } } }, first: 50) { nodes { id labelIds } } }"}' "$label_id")
  local resp_issues
  resp_issues=$(curl -sf -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: ${LINEAR_API_KEY}" \
    --data "$query_issues" \
    "$LINEAR_API_URL" 2>/dev/null) || true

  local issue_count
  issue_count=$(echo "$resp_issues" | jq '.data.issues.nodes | length' 2>/dev/null) || true

  if [ -z "$issue_count" ] || [ "$issue_count" -eq 0 ]; then
    log "No issues with 'usage-limit' label found"
    return 0
  fi

  log "Removing 'usage-limit' label from ${issue_count} issue(s)..."

  # 3. 各 Issue からusage-limitラベルを除去（他のラベルは保持）
  local issues_json
  issues_json=$(echo "$resp_issues" | jq -c '.data.issues.nodes[]' 2>/dev/null) || true

  while IFS= read -r issue_json; do
    local issue_id
    issue_id=$(echo "$issue_json" | jq -r '.id' 2>/dev/null) || true
    [ -z "$issue_id" ] || [ "$issue_id" == "null" ] && continue

    # 既存ラベルIDからusage-limitを除いたリストを作る
    local new_label_ids
    new_label_ids=$(echo "$issue_json" | jq -r --arg lid "$label_id" '[.labelIds[] | select(. != $lid)] | @json' 2>/dev/null) || true
    [ -z "$new_label_ids" ] && new_label_ids='[]'

    local mutation_update
    mutation_update=$(printf '{"query":"mutation { issueUpdate(id: \\"%s\\", input: { labelIds: %s }) { success } }"}' "$issue_id" "$new_label_ids")
    curl -sf -X POST \
      -H "Content-Type: application/json" \
      -H "Authorization: ${LINEAR_API_KEY}" \
      --data "$mutation_update" \
      "$LINEAR_API_URL" >/dev/null 2>&1 || true

    log "Removed 'usage-limit' label from issue: ${issue_id}"
  done <<< "$issues_json"

  log "Usage-limit label removal completed"
  return 0
}

# --- stop ---
if [[ "${1:-}" == "stop" ]]; then
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID"
      rm -f "$PID_FILE"
      echo "Scheduler stopped (PID: ${PID})"
    else
      echo "Scheduler not running (stale PID file removed)"
      rm -f "$PID_FILE"
    fi
  else
    echo "Scheduler is not running"
  fi
  exit 0
fi

# --- status ---
if [[ "${1:-}" == "status" ]]; then
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      echo "Scheduler is running (PID: ${PID})"
      echo "Log: ${SCHEDULER_LOG}"
      if [ -f "$LINEAR_STATE_FILE" ]; then
        echo "Last Linear updatedAt: $(cat "$LINEAR_STATE_FILE")"
      else
        echo "Last Linear updatedAt: (not yet checked)"
      fi
      if [ -n "${LINEAR_API_KEY:-}" ]; then
        echo "Mode: Linear polling (CHECK_INTERVAL=${CHECK_INTERVAL}s)"
      else
        echo "Mode: Fixed interval fallback (INTERVAL=${INTERVAL}s) — set LINEAR_API_KEY to enable Linear polling"
      fi
    else
      echo "Scheduler not running (stale PID file)"
    fi
  else
    echo "Scheduler is not running"
  fi
  exit 0
fi

# --- watch モード（バックグラウンド起動 + tail -f でリアルタイム表示）---
if [[ "${1:-}" == "--watch" ]]; then
  SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

  # すでに動いていれば止める
  if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "Stopping existing scheduler (PID: ${OLD_PID})..."
      kill "$OLD_PID"
      sleep 1
    fi
    rm -f "$PID_FILE"
  fi

  # バックグラウンドで起動し $! で確実にPIDを捕捉
  bash "$SCRIPT_PATH" --foreground >> "$SCHEDULER_LOG" 2>&1 &
  SCHED_PID=$!
  sleep 1

  if ! kill -0 "$SCHED_PID" 2>/dev/null; then
    echo "Failed to start scheduler" >&2
    exit 1
  fi

  echo "Scheduler running (PID: ${SCHED_PID}). Watching log."
  echo "Ctrl+C to stop scheduler."
  echo ""

  _stop_watch() {
    echo ""
    echo "Stopping scheduler (PID: ${SCHED_PID})..."
    kill "$SCHED_PID" 2>/dev/null || true
    kill "$TAIL_PID"  2>/dev/null || true
    exit 0
  }
  trap _stop_watch INT TERM

  tail -f "$SCHEDULER_LOG" &
  TAIL_PID=$!

  wait "$SCHED_PID" 2>/dev/null || true
  kill "$TAIL_PID" 2>/dev/null || true
  exit 0
fi

# --- foreground loop (PIDファイルはここで書く) ---
if [[ "${1:-}" == "--foreground" ]]; then
  echo $$ > "$PID_FILE"

  if [[ "$WEBHOOK_MODE" == "true" ]]; then
    log "WEBHOOK_MODE=true: polling disabled. Scheduler exiting."
    rm -f "$PID_FILE"
    exit 0
  fi

  _SLEEP_PID=""
  _RUN_PID=""
  _fg_cleanup() {
    kill "$_SLEEP_PID" 2>/dev/null || true
    # 実行中の run_auto.sh がある場合は完了を待つ（途中で kill すると Execution error になるため）
    if [[ -n "$_RUN_PID" ]]; then
      log "Scheduler stopping — waiting for current run to complete (PID: ${_RUN_PID})..."
      wait "$_RUN_PID" 2>/dev/null || true
      _release_lock
    fi
    rm -f "$PID_FILE"
    log "Scheduler stopped"
    exit 0
  }
  trap '_fg_cleanup' SIGTERM
  trap '' SIGINT

  if [ -n "${LINEAR_API_KEY:-}" ]; then
    log "Scheduler started (PID: $$, mode: Linear polling, check_interval: ${CHECK_INTERVAL}s)"
  else
    log "Scheduler started (PID: $$, mode: fixed interval fallback, interval: ${INTERVAL}s)"
    log "WARNING: LINEAR_API_KEY is not set. Set it to enable Linear-triggered execution."
  fi

  while true; do
    if [ -n "${LINEAR_API_KEY:-}" ]; then
      # Linear ポーリングモード: CHECK_INTERVAL 待機後にチェック・実行
      # 初回はスケジューラー起動時点から、再実行時はタスク完了後からカウント開始
      log "Next check in ${CHECK_INTERVAL}s"
      sleep "$CHECK_INTERVAL" &
      _SLEEP_PID=$!
      wait "$_SLEEP_PID" 2>/dev/null || true

      update_status=0
      linear_has_updates || update_status=$?

      if [ "$update_status" -eq 0 ]; then
        log "--- Run start (active issues found) ---"
        if ! _acquire_lock; then
          log "SKIPPED_LOCKED: run_auto.sh skipped (lock not available)"
          continue
        fi
        _tmp_log=$(mktemp)
        bash scripts/ai/run_auto.sh > "$_tmp_log" 2>&1 &
        _RUN_PID=$!
        wait "$_RUN_PID" && _run_exit=0 || _run_exit=$?
        _RUN_PID=""
        cat "$_tmp_log" >> "$AUTO_RUNNER_LOG"
        cat "$_tmp_log" >> "$SCHEDULER_LOG"
        _release_lock
        if [ "$_run_exit" -eq "$SKIPPED_LOCKED" ]; then
          log "--- Run SKIPPED_LOCKED (lock not available) ---"
        elif [ "$_run_exit" -eq 0 ]; then
          log "--- Run completed successfully ---"
          _remove_usage_limit_label
        else
          log "--- Run failed (exit: ${_run_exit}) ---"
          _session_wait=$(_parse_session_reset_epoch "$(cat "$_tmp_log")") || _session_wait=""
          if [ -n "$_session_wait" ]; then
            _reset_disp=$(date -u -d "@$((_session_wait - 600))" '+%H:%M UTC')
            _wait_min=$(( (_session_wait - $(date -u +%s) + 59) / 60 ))
            log "Session limit detected (reset: ${_reset_disp}). Waiting until 10 min after reset (~${_wait_min} min)..."
            _notify_via_codex "$_session_wait"
            while true; do
              _now_e=$(date -u +%s)
              _rem=$((_session_wait - _now_e))
              if [ "$_rem" -le 0 ]; then break; fi
              _chunk=$(( _rem < 30 ? _rem : 30 ))
              sleep "$_chunk" &
              _SLEEP_PID=$!
              wait "$_SLEEP_PID" 2>/dev/null || true
            done
            log "--- Run start (session limit reset, forced) ---"
            # forced run also needs lock
            if ! _acquire_lock; then
              log "SKIPPED_LOCKED: run_auto.sh skipped (lock not available)"
            else
              _tmp_log2=$(mktemp)
              bash scripts/ai/run_auto.sh > "$_tmp_log2" 2>&1 &
              _RUN_PID=$!
              wait "$_RUN_PID" && _run_exit=0 || _run_exit=$?
              _RUN_PID=""
              cat "$_tmp_log2" >> "$AUTO_RUNNER_LOG"
              cat "$_tmp_log2" >> "$SCHEDULER_LOG"
              rm -f "$_tmp_log2"
              _release_lock
              if [ "$_run_exit" -eq "$SKIPPED_LOCKED" ]; then
                log "--- Run SKIPPED_LOCKED (lock not available) ---"
              elif [ "$_run_exit" -eq 0 ]; then
                log "--- Run completed successfully ---"
                _remove_usage_limit_label
              else
                log "--- Run failed (exit: ${_run_exit}) ---"
              fi
            fi
          fi
        fi
        rm -f "$_tmp_log"
      elif [ "$update_status" -eq 1 ]; then
        log "No active issues (Todo/In Progress) in Linear, skipping run."
      else
        log "Linear API key not set (unexpected), skipping."
      fi
    else
      # フォールバック: INTERVAL 待機後に実行
      # 初回はスケジューラー起動時点から、再実行時はタスク完了後からカウント開始
      log "Next run in ${INTERVAL}s"
      sleep "$INTERVAL" &
      _SLEEP_PID=$!
      wait "$_SLEEP_PID" 2>/dev/null || true

      log "--- Run start (fixed interval) ---"
      if ! _acquire_lock; then
        log "SKIPPED_LOCKED: run_auto.sh skipped (lock not available)"
        continue
      fi
      _tmp_log=$(mktemp)
      bash scripts/ai/run_auto.sh > "$_tmp_log" 2>&1 &
      _RUN_PID=$!
      wait "$_RUN_PID" && _run_exit=0 || _run_exit=$?
      _RUN_PID=""
      cat "$_tmp_log" >> "$AUTO_RUNNER_LOG"
      cat "$_tmp_log" >> "$SCHEDULER_LOG"
      _release_lock
      if [ "$_run_exit" -eq "$SKIPPED_LOCKED" ]; then
        log "--- Run SKIPPED_LOCKED (lock not available) ---"
      elif [ "$_run_exit" -eq 0 ]; then
        log "--- Run completed successfully ---"
        _remove_usage_limit_label
      else
        log "--- Run failed (exit: ${_run_exit}) ---"
        _session_wait=$(_parse_session_reset_epoch "$(cat "$_tmp_log")") || _session_wait=""
        if [ -n "$_session_wait" ]; then
          _reset_disp=$(date -u -d "@$((_session_wait - 600))" '+%H:%M UTC')
          _wait_min=$(( (_session_wait - $(date -u +%s) + 59) / 60 ))
          log "Session limit detected (reset: ${_reset_disp}). Waiting until 10 min after reset (~${_wait_min} min)..."
          _notify_via_codex "$_session_wait"
          while true; do
            _now_e=$(date -u +%s)
            _rem=$((_session_wait - _now_e))
            if [ "$_rem" -le 0 ]; then break; fi
            _chunk=$(( _rem < 30 ? _rem : 30 ))
            sleep "$_chunk" &
            _SLEEP_PID=$!
            wait "$_SLEEP_PID" 2>/dev/null || true
          done
          log "--- Run start (session limit reset, forced) ---"
          # forced run also needs lock
          if ! _acquire_lock; then
            log "SKIPPED_LOCKED: run_auto.sh skipped (lock not available)"
          else
            _tmp_log2=$(mktemp)
            bash scripts/ai/run_auto.sh > "$_tmp_log2" 2>&1 &
            _RUN_PID=$!
            wait "$_RUN_PID" && _run_exit=0 || _run_exit=$?
            _RUN_PID=""
            cat "$_tmp_log2" >> "$AUTO_RUNNER_LOG"
            cat "$_tmp_log2" >> "$SCHEDULER_LOG"
            rm -f "$_tmp_log2"
            _release_lock
            if [ "$_run_exit" -eq "$SKIPPED_LOCKED" ]; then
              log "--- Run SKIPPED_LOCKED (lock not available) ---"
            elif [ "$_run_exit" -eq 0 ]; then
              log "--- Run completed successfully ---"
              _remove_usage_limit_label
            else
              log "--- Run failed (exit: ${_run_exit}) ---"
            fi
          fi
        fi
      fi
      rm -f "$_tmp_log"
    fi
  done
  exit 0
fi

# --- バックグラウンド起動 (PIDファイルチェックはここだけ) ---
if [ -f "$PID_FILE" ]; then
  EXISTING_PID=$(cat "$PID_FILE")
  if kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "Scheduler is already running (PID: ${EXISTING_PID})" >&2
    exit 1
  fi
  rm -f "$PID_FILE"
fi

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
nohup bash "$SCRIPT_PATH" --foreground >> "$SCHEDULER_LOG" 2>&1 &

sleep 1
if [ -f "$PID_FILE" ]; then
  echo "Scheduler started (PID: $(cat "$PID_FILE"))"
else
  echo "Scheduler launched (log: ${SCHEDULER_LOG})"
fi

if [ -n "${LINEAR_API_KEY:-}" ]; then
  echo "Mode: Linear polling (CHECK_INTERVAL=${CHECK_INTERVAL}s)"
else
  echo "Mode: Fixed interval fallback (INTERVAL=${INTERVAL}s)"
  echo "Note: Set LINEAR_API_KEY to enable Linear update detection"
fi
echo "Log: ${SCHEDULER_LOG}"
