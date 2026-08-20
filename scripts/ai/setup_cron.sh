#!/usr/bin/env bash
# cron を使ってスケジュール実行をセットアップする
# devcontainer 再起動のたびに実行が必要

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
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

# run_auto.sh now requires a concrete issue id and is dispatched by the webhook queue. Remove the
# obsolete untargeted hourly entry left by older installations; otherwise it only exits with an error
# (or collides with an active run's flock). Do not register it again.
crontab -l 2>/dev/null | grep -v "run_auto.sh" | crontab - || true

# Kaggle 改善サイクル cron —【完了駆動ループ】(10分毎)。
# JST時刻枠は使わない。--all-competitions で registry の全コンペを毎tick評価し、前サイクル完了済みの
# improve ターゲットに次サイクルを即起案する（直列ガード findOpenImproveCycleParent が In Review 親も
# 未完了として数えるので二重起票しない）。default OFF（env KAGGLE_IMPROVE_ENABLED + registry.enabled）
# なので、登録しても2段 kill switch が ON になるまで実起案しない。
KAGGLE_IMPROVE_LOG="${REPO_DIR}/docs/ai/auto_logs/kaggle_improve.log"
IMPROVE_SCHEDULE="${KAGGLE_IMPROVE_CRON_SCHEDULE:-*/10 * * * *}"
# 実起案・実提出するかは env KAGGLE_IMPROVE_EXECUTE（既定ドライラン）。
# 実行モードでは 2段 kill switch の env 側（KAGGLE_IMPROVE_ENABLED）も ON である必要がある。
# 【重要】cron は登録時のシェル env を継承しない。旧実装 `KAGGLE_IMPROVE_ENABLED=${KAGGLE_IMPROVE_ENABLED:-}`
# は cron 実行時に空へ展開され、登録しても永久に dry-run のままになるバグだった。ここでは実行モードの
# ときだけ enable フラグを crontab 行へ **リテラルで焼き込む**（登録時に値を確定）。
# 完了駆動ループ: 時刻枠(--only-scheduled)は使わず、全コンペを毎tick評価する(--all-competitions)。
IMPROVE_FLAGS="--all-competitions"
IMPROVE_ENV=""
if [ "${KAGGLE_IMPROVE_EXECUTE:-0}" = "1" ]; then
  IMPROVE_FLAGS="--all-competitions --execute"
  IMPROVE_ENV="KAGGLE_IMPROVE_ENABLED=${KAGGLE_IMPROVE_ENABLED:-1} "
fi
IMPROVE_CMD="${IMPROVE_SCHEDULE} cd ${REPO_DIR} && ${IMPROVE_ENV}bash scripts/ai/kaggle_improvement_cycle.sh ${IMPROVE_FLAGS} >> ${KAGGLE_IMPROVE_LOG} 2>&1"
(crontab -l 2>/dev/null | grep -v "kaggle_improvement_cycle.sh"; echo "$IMPROVE_CMD") | crontab -

echo "Cron jobs registered:"
crontab -l | grep "kaggle_improvement_cycle"
echo ""
echo "Log: ${KAGGLE_IMPROVE_LOG}"
echo ""
echo "To remove: crontab -l | grep -vE 'run_auto.sh|kaggle_improvement_cycle.sh' | crontab -"
