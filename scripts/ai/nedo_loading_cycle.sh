#!/usr/bin/env bash
# NEDO 積付アルゴリズム自動改善サイクル — cron ラッパ（sonnet_gold_cycle.sh と同型）。
# 10分毎 cron から呼ばれ、完了駆動（前サイクル親の完了検知）で次サイクルを起票する。
# 停止: docs/ai/auto_logs/nedo_loading_cycle.stop を作成するか crontab の行を削除。
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# .env を読み込む（cron 環境には LINEAR_API_KEY が無いため）。
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

echo "=== nedo_loading_cycle $(date -u +%FT%TZ) ==="
if npx --no-install tsx scripts/ai/nedo_loading_cycle_draft.ts --only-scheduled "$@"; then
  :
else
  npx tsx scripts/ai/nedo_loading_cycle_draft.ts --only-scheduled "$@"
fi
