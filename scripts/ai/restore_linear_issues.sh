#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Load .env if present without executing its contents.
if [ -f "${PROJECT_ROOT}/.env" ]; then
  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"

    case "${line}" in
      ""|\#*) continue ;;
      export\ *) line="${line#export }" ;;
    esac

    key="${line%%=*}"
    value="${line#*=}"

    if [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      value="${value%\"}"
      value="${value#\"}"
      value="${value%\'}"
      value="${value#\'}"
      export "${key}=${value}"
    fi
  done < "${PROJECT_ROOT}/.env"
fi

# Validate required env var
if [ -z "${LINEAR_API_KEY:-}" ]; then
  echo "ERROR: LINEAR_API_KEY is not set. Please set it in .env or environment." >&2
  exit 1
fi

# Run Python implementation
python3 "${SCRIPT_DIR}/restore_linear_issues.py" "$@"
