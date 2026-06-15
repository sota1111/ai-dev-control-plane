#!/usr/bin/env bash
# Firebase Auth config check script
# Usage: bash scripts/check-auth-config.sh

set -uo pipefail

CONTROL_PLANE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS_JSON="$CONTROL_PLANE_DIR/config/auth/apps.json"

if [ ! -f "$APPS_JSON" ]; then
  echo "ERROR: apps.json not found at $APPS_JSON" >&2
  exit 1
fi

PASS=0
FAIL=0
WARN=0

check_repo() {
  local name="$1"
  local local_path="$2"
  local status="$3"

  echo ""
  echo "=== $name (status: $status) ==="

  if [ ! -d "$local_path" ]; then
    echo "  SKIP: directory not found ($local_path)"
    return
  fi

  # Check .env.example for Firebase vars
  if [ -f "$local_path/.env.example" ]; then
    if grep -qE "FIREBASE|firebase" "$local_path/.env.example" 2>/dev/null; then
      echo "  OK   .env.example has Firebase vars"
      PASS=$((PASS+1))
    else
      if [ "$status" != "todo" ]; then
        echo "  WARN .env.example missing Firebase vars"
        WARN=$((WARN+1))
      fi
    fi
  else
    echo "  WARN .env.example not found"
    WARN=$((WARN+1))
  fi

  if [ -f "$local_path/README.md" ]; then
    # ALLOWED_USER_EMAILS (skip todo and frontend-only)
    if [ "$status" != "todo" ] && [ "$status" != "done-frontend-only" ]; then
      if grep -q "ALLOWED_USER_EMAILS" "$local_path/README.md" 2>/dev/null; then
        echo "  OK   README mentions ALLOWED_USER_EMAILS"
        PASS=$((PASS+1))
      else
        echo "  FAIL README missing ALLOWED_USER_EMAILS"
        FAIL=$((FAIL+1))
      fi
    fi

    # AUTH_SECRET (skip todo and frontend-only)
    if [ "$status" != "todo" ] && [ "$status" != "done-frontend-only" ]; then
      if grep -q "AUTH_SECRET" "$local_path/README.md" 2>/dev/null; then
        echo "  OK   README mentions AUTH_SECRET"
        PASS=$((PASS+1))
      else
        echo "  WARN README missing AUTH_SECRET"
        WARN=$((WARN+1))
      fi
    fi

    # Cloud Run access docs
    if grep -qE "allow-unauthenticated|Cloud Run" "$local_path/README.md" 2>/dev/null; then
      echo "  OK   README mentions Cloud Run configuration"
      PASS=$((PASS+1))
    else
      echo "  WARN README missing Cloud Run configuration"
      WARN=$((WARN+1))
    fi
  else
    echo "  WARN README.md not found"
    WARN=$((WARN+1))
  fi

  # Check for old auth variables in runtime source files
  local old_vars
  old_vars=$(grep -r "\bAUTH_USERNAME\b\|\bAUTH_PASSWORD\b\|\bAUTH_SECRET_KEY\b\|\bJWT_SECRET\b\|\bVITE_AUTH_PASSWORD\b" \
    "$local_path/" --include="*.py" --include="*.ts" --include="*.tsx" --include="*.js" \
    --exclude-dir=".git" --exclude-dir="node_modules" --exclude-dir="__pycache__" \
    -l 2>/dev/null || true)

  if [ -n "$old_vars" ]; then
    echo "  WARN Old auth vars in source:"
    echo "$old_vars" | while IFS= read -r f; do echo "       $f"; done
    WARN=$((WARN+1))
  else
    echo "  OK   No old auth vars in source files"
    PASS=$((PASS+1))
  fi
}

echo "Firebase Auth Config Check"
echo "=========================="

# Read apps.json with python3 and call check_repo for each entry
while IFS=$'\t' read -r name local_path status; do
  check_repo "$name" "$local_path" "$status"
done < <(python3 -c "
import json
with open('$APPS_JSON') as f:
    apps = json.load(f)
for a in apps:
    print(a['name'] + '\t' + a.get('localPath','') + '\t' + a.get('authMigrationStatus','unknown'))
")

echo ""
echo "=========================="
echo "Summary: PASS=$PASS  WARN=$WARN  FAIL=$FAIL"
if [ $FAIL -gt 0 ]; then
  echo "STATUS: FAILED"
  exit 1
elif [ $WARN -gt 0 ]; then
  echo "STATUS: WARNINGS (review above)"
  exit 0
else
  echo "STATUS: ALL CLEAN"
  exit 0
fi
