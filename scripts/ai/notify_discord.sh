#!/usr/bin/env bash
# SOT-1577: worker-facing wrapper so a dispatched `-p` worker can post a short progress update to
# Discord DIRECTLY while it works (not only the end-of-run report). Best-effort: always exits 0 so a
# notification failure never blocks or fails the worker's actual role task.
#
#   bash scripts/ai/notify_discord.sh "one-line progress update"
#   echo "multi-line message" | bash scripts/ai/notify_discord.sh
#
# Context (issue id / role / worker) is read from the run env (WEBHOOK_ISSUE_ID / WORKER_ROLE /
# WORKER_SELECTED) by runner-cli and prepended automatically — pass only the human-readable message.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTROL_PLANE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
_TSX_BIN="$CONTROL_PLANE_DIR/node_modules/.bin/tsx"

MSG="$*"
if [ -z "$MSG" ] && [ ! -t 0 ]; then
  MSG="$(cat)"
fi
if [ -z "${MSG// /}" ]; then
  echo "notify_discord.sh: empty message, nothing sent" >&2
  exit 0
fi

if [ -x "$_TSX_BIN" ]; then
  (cd "$CONTROL_PLANE_DIR" && "$_TSX_BIN" src/runner-cli.ts notify-discord "$MSG") >/dev/null 2>&1 || true
else
  (cd "$CONTROL_PLANE_DIR" && npx tsx src/runner-cli.ts notify-discord "$MSG") >/dev/null 2>&1 || true
fi

exit 0
