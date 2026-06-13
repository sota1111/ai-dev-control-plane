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
DISCORD_BUFFER_FILE="/tmp/ai-scheduler-discord-buffer-$$.txt"
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
  _discord_buffer_add "$msg"
}

_discord_buffer_add() {
  if [ -n "${DISCORD_WEBHOOK_URL:-}" ]; then
    printf '%s\n' "$*" >> "$DISCORD_BUFFER_FILE"
  fi
}

_discord_flush() {
  if [ -z "${DISCORD_WEBHOOK_URL:-}" ]; then return; fi
  [ -f "$DISCORD_BUFFER_FILE" ] && [ -s "$DISCORD_BUFFER_FILE" ] || return
  local content
  content=$(cat "$DISCORD_BUFFER_FILE")
  > "$DISCORD_BUFFER_FILE"
  # Split into 1990-char chunks and post each
  while [ "${#content}" -gt 0 ]; do
    local chunk="${content:0:1990}"
    content="${content:1990}"
    local escaped
    escaped=$(node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('/dev/stdin','utf8')))" <<< "$chunk" 2>/dev/null) || \
    escaped=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$chunk" 2>/dev/null) || \
    escaped="\"${chunk//\"/\\\"}\""
    local http_code
    http_code=$(curl -sf -o /tmp/_discord_resp_$$.txt -w "%{http_code}" -X POST \
      -H "Content-Type: application/json" \
      --data "{\"content\":${escaped}}" \
      "$DISCORD_WEBHOOK_URL" 2>/dev/null) || http_code="0"
    if [ "$http_code" = "429" ]; then
      local retry_after
      retry_after=$(grep -o '"retry_after":[0-9.]*' /tmp/_discord_resp_$$.txt 2>/dev/null | cut -d: -f2 || echo "5")
      sleep "${retry_after:-5}"
      curl -sf -X POST \
        -H "Content-Type: application/json" \
        --data "{\"content\":${escaped}}" \
        "$DISCORD_WEBHOOK_URL" > /dev/null 2>&1 || true
    fi
    rm -f /tmp/_discord_resp_$$.txt
  done
}

_discord_flush_loop() {
  while true; do
    sleep 5
    _discord_flush
  done
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

  _DISCORD_FLUSH_PID=""
  if [ -n "${DISCORD_WEBHOOK_URL:-}" ]; then
    _discord_flush_loop &
    _DISCORD_FLUSH_PID=$!
  fi

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
    kill "${_DISCORD_FLUSH_PID:-}" 2>/dev/null || true
    _discord_flush
    rm -f "$DISCORD_BUFFER_FILE"
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
          node src/runner-cli.js remove-usage-limit-label >> "$AUTO_RUNNER_LOG" 2>&1 || true
        else
          log "--- Run failed (exit: ${_run_exit}) ---"
          _session_wait=$(node src/runner-cli.js parse-usage-limit-epoch < "$_tmp_log" 2>/dev/null) || _session_wait=""
          if [ -n "$_session_wait" ]; then
            _reset_disp=$(date -u -d "@$((_session_wait - 600))" '+%H:%M UTC')
            _wait_min=$(( (_session_wait - $(date -u +%s) + 59) / 60 ))
            log "Session limit detected (reset: ${_reset_disp}). Waiting until 10 min after reset (~${_wait_min} min)..."
            node src/runner-cli.js notify-usage-limit "$_session_wait" >> "$AUTO_RUNNER_LOG" 2>&1 || true
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
                node src/runner-cli.js remove-usage-limit-label >> "$AUTO_RUNNER_LOG" 2>&1 || true
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
        node src/runner-cli.js remove-usage-limit-label >> "$AUTO_RUNNER_LOG" 2>&1 || true
      else
        log "--- Run failed (exit: ${_run_exit}) ---"
        _session_wait=$(node src/runner-cli.js parse-usage-limit-epoch < "$_tmp_log" 2>/dev/null) || _session_wait=""
        if [ -n "$_session_wait" ]; then
          _reset_disp=$(date -u -d "@$((_session_wait - 600))" '+%H:%M UTC')
          _wait_min=$(( (_session_wait - $(date -u +%s) + 59) / 60 ))
          log "Session limit detected (reset: ${_reset_disp}). Waiting until 10 min after reset (~${_wait_min} min)..."
          node src/runner-cli.js notify-usage-limit "$_session_wait" >> "$AUTO_RUNNER_LOG" 2>&1 || true
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
              node src/runner-cli.js remove-usage-limit-label >> "$AUTO_RUNNER_LOG" 2>&1 || true
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
