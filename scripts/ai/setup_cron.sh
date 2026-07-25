#!/usr/bin/env bash
# cron を使ってスケジュール実行をセットアップする
# devcontainer 再起動のたびに実行が必要

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CRON_SCHEDULE="${CRON_SCHEDULE:-0 * * * *}"   # デフォルト毎時0分
CRON_LOG="${REPO_DIR}/docs/ai/auto_logs/cron.log"

mkdir -p "${REPO_DIR}/docs/ai/auto_logs"

# cron がなければインストール
if ! command -v cron &>/dev/null; then
  echo "Installing cron..."
  sudo apt-get install -y cron
fi

# cron サービス起動
if ! service cron status &>/dev/null; then
  echo "Starting cron service..."
  sudo service cron start
fi

# 既存エントリを削除して追加
CRON_CMD="${CRON_SCHEDULE} cd ${REPO_DIR} && bash scripts/ai/run_auto.sh >> ${CRON_LOG} 2>&1"
(crontab -l 2>/dev/null | grep -v "run_auto.sh"; echo "$CRON_CMD") | crontab -

# SOT-1913/SOT-1933: Kaggle 改善サイクル cron（単一スケジュール JST [0,4,8,12,16,20]・1枠=1コンペ）。
# cron は UTC 基準なので毎時起動し、スクリプト側で --only-scheduled により当番 JST 枠だけを処理する
# （registry.schedule_hours_jst で枠を判定）。default OFF（env KAGGLE_IMPROVE_ENABLED + registry.enabled）
# なので、登録しても2段 kill switch が ON になるまで実起案しない。
KAGGLE_IMPROVE_LOG="${REPO_DIR}/docs/ai/auto_logs/kaggle_improve.log"
IMPROVE_SCHEDULE="${KAGGLE_IMPROVE_CRON_SCHEDULE:-0 * * * *}"
# 実起案するかは env KAGGLE_IMPROVE_EXECUTE（既定ドライラン）。
IMPROVE_FLAGS="--only-scheduled"
if [ "${KAGGLE_IMPROVE_EXECUTE:-0}" = "1" ]; then IMPROVE_FLAGS="--only-scheduled --execute"; fi
IMPROVE_CMD="${IMPROVE_SCHEDULE} cd ${REPO_DIR} && KAGGLE_IMPROVE_ENABLED=\${KAGGLE_IMPROVE_ENABLED:-} bash scripts/ai/kaggle_improvement_cycle.sh ${IMPROVE_FLAGS} >> ${KAGGLE_IMPROVE_LOG} 2>&1"
(crontab -l 2>/dev/null | grep -v "kaggle_improvement_cycle.sh"; echo "$IMPROVE_CMD") | crontab -

echo "Cron jobs registered:"
crontab -l | grep -E "run_auto|kaggle_improvement_cycle"
echo ""
echo "Logs: ${CRON_LOG} / ${KAGGLE_IMPROVE_LOG}"
echo ""
echo "To remove: crontab -l | grep -vE 'run_auto.sh|kaggle_improvement_cycle.sh' | crontab -"
