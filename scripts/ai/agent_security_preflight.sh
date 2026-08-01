#!/usr/bin/env bash
set -euo pipefail

# Deterministic restart gate for Agent Security improvement issues. It deliberately checks the
# repository-owned virtualenv, because the SDK is not expected to be importable from system Python.
repo="${1:-}"
if [ -z "$repo" ] || [ ! -d "$repo" ]; then
  echo '{"ok":false,"reason":"repository path is missing or invalid"}'
  exit 2
fi

python_bin="$repo/.venv/bin/python"
if [ ! -x "$python_bin" ]; then
  echo '{"ok":false,"reason":"repository .venv/bin/python is missing"}'
  exit 3
fi

"$python_bin" - <<'PY'
import importlib.metadata
import json

try:
    version = importlib.metadata.version("aicomp-sdk")
    import aicomp_sdk  # noqa: F401
except Exception as exc:
    print(json.dumps({"ok": False, "reason": f"aicomp_sdk unavailable: {type(exc).__name__}: {exc}"}))
    raise SystemExit(4)

print(json.dumps({"ok": True, "module": "aicomp_sdk", "distribution": "aicomp-sdk", "version": version}))
PY
