#!/usr/bin/env bash
# Webhook-only migration helper.
#
# ai-dev-control-plane no longer creates work on a schedule. It receives signed Linear webhooks,
# reconciles active Linear issues on startup/reaper ticks, and executes the persistent queue. The
# research/drafting loop now lives in epistemic-research-loop.

set -euo pipefail

if ! command -v crontab >/dev/null 2>&1; then
  echo "crontab is not installed; no legacy entries to remove"
  exit 0
fi

# Remove every historical work-creation entry. Never register a replacement here.
LEGACY_PATTERN='run_auto\.sh|sonnet_gold_cycle\.sh|nedo_loading_cycle\.sh'
crontab -l 2>/dev/null | grep -vE "$LEGACY_PATTERN" | crontab - || true

echo "Legacy automatic drafting cron entries removed."
echo "Start the execution ingress with: npm run start:webhook"
echo "Research scheduling is owned by the epistemic-research-loop repository."
