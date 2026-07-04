#!/usr/bin/env bash
# SOT-1514 / P2: Linear read/write bridge over the Codex CLI.
#
# When Claude Code's own Linear MCP is unauthenticated in a run, Linear reads/writes are bridged
# through the Codex CLI's separate Linear login. Historically each *write* first hit Codex's
# approval gate and was auto-denied ("user cancelled MCP tool call"), wasting a whole codex exec
# round-trip before a second call added the bypass flag. This wrapper bakes in
# `--dangerously-bypass-approvals-and-sandbox` from the first call (the harness env is already
# externally sandboxed), so writes land on the first try — and it encourages consolidating
# multiple Linear operations (e.g. a status change + one or more comments) into ONE instruction =
# ONE codex exec round-trip, instead of N separate spawns.
#
# Usage:
#   scripts/ai/linear_bridge.sh [--timeout SECONDS] "<instruction>"
#   scripts/ai/linear_bridge.sh [--timeout SECONDS] --file <path-to-instruction-file>
#   echo "<instruction>" | scripts/ai/linear_bridge.sh [--timeout SECONDS] --stdin
#
# The <instruction> tells Codex exactly which Linear MCP operations to perform and to print DONE
# or LINEAR_ERROR at the end. Keep each invocation to one focused batch of operations (a single
# combined "post long comment + list statuses + save_issue" call has been observed to time out —
# split large multi-step work into separate calls). For a long/verbatim comment body, write it to
# a temp file and instruct Codex to read that file and post its exact contents (avoids arg-escaping
# issues) rather than embedding the whole body in the instruction.
#
# Env:
#   LINEAR_BRIDGE_TIMEOUT   default timeout in seconds when --timeout is omitted (default 200)
#   CODEX_BIN               codex binary to invoke (default: codex)
set -euo pipefail

TIMEOUT="${LINEAR_BRIDGE_TIMEOUT:-200}"
CODEX_BIN="${CODEX_BIN:-codex}"
MODE="arg"
INSTRUCTION=""
FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --timeout) TIMEOUT="${2:-}"; shift 2 ;;
    --file) MODE="file"; FILE="${2:-}"; shift 2 ;;
    --stdin) MODE="stdin"; shift ;;
    --) shift; break ;;
    -*) echo "linear_bridge: unknown option: $1" >&2; exit 2 ;;
    *) INSTRUCTION="$1"; shift ;;
  esac
done

case "$MODE" in
  file)
    if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
      echo "linear_bridge: --file requires an existing file (got '$FILE')" >&2; exit 2
    fi
    INSTRUCTION="$(cat "$FILE")"
    ;;
  stdin)
    INSTRUCTION="$(cat)"
    ;;
esac

if [ -z "${INSTRUCTION//[[:space:]]/}" ]; then
  echo "linear_bridge: empty instruction" >&2; exit 2
fi
if ! [[ "$TIMEOUT" =~ ^[0-9]+$ ]]; then
  echo "linear_bridge: --timeout must be an integer number of seconds (got '$TIMEOUT')" >&2; exit 2
fi

# One codex exec, approval bypass baked in from the first call (env already externally sandboxed).
exec timeout "$TIMEOUT" "$CODEX_BIN" --dangerously-bypass-approvals-and-sandbox exec "$INSTRUCTION"
