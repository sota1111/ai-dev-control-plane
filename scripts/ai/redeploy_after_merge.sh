#!/usr/bin/env bash
# SOT-1421 / P6 — best-effort auto-redeploy after a PR merge.
#
# Completed Issues almost always ended with a manual "要redeploy" step. This hook makes "merged =
# deployed" reachable when a deploy command is configured, WITHOUT ever blocking the merge/flow.
#
# It is intentionally OFF by default: real cloud deploys need per-repo credentials that live in the
# deploy environment, not this repo. Enable by setting REDEPLOY_ENABLED=1 in an environment that has
# the credentials, and configuring a command (see resolution order below).
#
# Usage:
#   scripts/ai/redeploy_after_merge.sh <repo-or-project> [localPath]
#     <repo-or-project> : repo slug "owner/name" OR project name (key into config/deploy_commands.json)
#     [localPath]       : directory to run the deploy command in (optional)
#
# Deploy command resolution (first non-empty wins):
#   1. $REDEPLOY_CMD                          (global env override)
#   2. config/deploy_commands.json[<key>]     (per-repo/per-project map; keys starting with __ ignored)
#
# Exit code is ALWAYS 0 unless called with bad usage: skipping (disabled / no command) and a failing
# deploy are both best-effort and must never break the caller.
set -uo pipefail

CONTROL_PLANE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

REPO_OR_PROJECT="${1:-}"
LOCAL_PATH="${2:-}"
if [ -z "$REPO_OR_PROJECT" ]; then
  echo "usage: redeploy_after_merge.sh <repo-or-project> [localPath]" >&2
  exit 2
fi

# Master switch — default OFF. Only attempt a deploy when explicitly enabled.
case "$(printf '%s' "${REDEPLOY_ENABLED:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) ;;
  *)
    echo "[REDEPLOY] disabled (REDEPLOY_ENABLED not set) — skipping redeploy for $REPO_OR_PROJECT"
    exit 0
    ;;
esac

# Resolve the deploy command.
CMD="${REDEPLOY_CMD:-}"
CONFIG="$CONTROL_PLANE_DIR/config/deploy_commands.json"
if [ -z "$CMD" ] && [ -f "$CONFIG" ]; then
  CMD="$(node -e "try{const m=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const k=process.argv[2];const v=(k&&!k.startsWith('__'))?m[k]:'';process.stdout.write(typeof v==='string'?v:'');}catch(e){process.stdout.write('');}" "$CONFIG" "$REPO_OR_PROJECT" 2>/dev/null || echo '')"
fi

if [ -z "$CMD" ]; then
  echo "[REDEPLOY] no deploy command configured for $REPO_OR_PROJECT — skipping (best-effort)"
  exit 0
fi

echo "[REDEPLOY] deploying $REPO_OR_PROJECT: $CMD"
(
  if [ -n "$LOCAL_PATH" ]; then cd "$LOCAL_PATH" || exit 1; fi
  bash -c "$CMD"
)
DEPLOY_EXIT=$?
if [ "$DEPLOY_EXIT" -ne 0 ]; then
  echo "[REDEPLOY] deploy command FAILED (exit $DEPLOY_EXIT) for $REPO_OR_PROJECT — best-effort, not blocking" >&2
  exit 0
fi
echo "[REDEPLOY] deploy complete for $REPO_OR_PROJECT"
exit 0
