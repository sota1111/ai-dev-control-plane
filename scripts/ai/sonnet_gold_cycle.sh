#!/usr/bin/env bash
# Sonnet local gold100 自動改善サイクル — cron ラッパ（kaggle_improvement_cycle.sh と同型）。
# 毎時 cron から呼ばれ、JST 4時間グリッド（1,5,9,13,17,21時）のみ drafter が起票する。
# 停止: docs/ai/auto_logs/sonnet_gold_cycle.stop を作成するか crontab の行を削除。
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

echo "=== sonnet_gold_cycle $(date -u +%FT%TZ) ==="
if npx --no-install tsx scripts/ai/sonnet_gold_cycle_draft.ts --only-scheduled "$@"; then
  :
else
  npx tsx scripts/ai/sonnet_gold_cycle_draft.ts --only-scheduled "$@"
fi
