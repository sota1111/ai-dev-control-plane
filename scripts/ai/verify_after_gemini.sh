#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   bash scripts/ai/verify_after_gemini.sh
#   TARGET_REPO=/workspaces/<project> bash scripts/ai/verify_after_gemini.sh

cd "$(dirname "$0")/../.."

# Load .env if it exists
if [ -f .env ]; then
  # shellcheck disable=SC1091
  source .env
fi

GEMINI_REPORT="docs/ai/50_worker_gemini_report.md"
CODEX_PROMPT="prompts/codex/debug.md"
CODEX_REPORT="docs/ai/60_worker_codex_report.md"
FINAL_REPORT="docs/ai/70_final_report.md"

if [ ! -f "$GEMINI_REPORT" ]; then
  echo "Error: Gemini report not found at $GEMINI_REPORT" >&2
  exit 1
fi

echo "Reading Gemini report: $GEMINI_REPORT"
NEXT_ACTION=$(awk '/^## Next Action/{found=1; next} found && NF{print; exit}' "$GEMINI_REPORT" | tr -d ' \r\n')

echo "Gemini Next Action: $NEXT_ACTION"

if [[ "$NEXT_ACTION" == "BLOCKED" || "$NEXT_ACTION" == "NEEDS_USER_INPUT" ]]; then
  echo "Gemini report indicates $NEXT_ACTION. Skipping Codex verification."
  exit 0
fi

if [[ "$NEXT_ACTION" != "NEEDS_DEBUG" && "$NEXT_ACTION" != "READY_FOR_REVIEW" ]]; then
  echo "Warning: Unexpected Next Action '$NEXT_ACTION'. Proceeding with Codex verification anyway."
fi

echo "Generating Codex prompt: $CODEX_PROMPT"
mkdir -p "$(dirname "$CODEX_PROMPT")"
cat <<EOF > "$CODEX_PROMPT"
# Codex Worker Instruction

You are a debugging and verification worker. You do NOT interact with the human directly.

## Context Files to Read First

- docs/ai/00_project_context.md
- docs/ai/40_acceptance.md
- docs/ai/50_worker_gemini_report.md

## Task

Verify the Gemini implementation. Read \`docs/ai/50_worker_gemini_report.md\` first.

## Verification Steps

### Step 1: Run lint
\`\`\`bash
npm run lint
\`\`\`

### Step 2: Run unit tests
\`\`\`bash
npm test
\`\`\`

### Step 3: Inspect changed files from Gemini report

Read the "Changed Files" section in \`docs/ai/50_worker_gemini_report.md\`.
For each changed file:
- Verify the change matches the stated intention
- Check for unintended modifications
- Verify no test files were accidentally modified

### Step 4: Check acceptance criteria

Read the "Acceptance Criteria" section in \`docs/ai/50_worker_gemini_report.md\`.
Verify each criterion is actually met in the code.

## Fix Constraints

- Apply ONLY minimal fixes for lint or test failures
- Do NOT expand scope beyond what Gemini implemented
- Do NOT refactor unrelated code
- Document every fix applied

## Output

Write your verification report to \`docs/ai/60_worker_codex_report.md\`.

Format: see prompts/codex/TEMPLATE.md for the standard report format.

## Next Action
READY_FOR_REVIEW | NEEDS_DEBUG | BLOCKED
EOF

echo "Running Codex..."
if [ -n "${TARGET_REPO:-}" ]; then
  TARGET_REPO="$TARGET_REPO" bash scripts/ai/run_codex.sh
else
  bash scripts/ai/run_codex.sh
fi

echo "Generating final report: $FINAL_REPORT"
CODEX_NEXT_ACTION=$(awk '/^## Next Action/{found=1; next} found && NF{print; exit}' "$CODEX_REPORT" | tr -d ' \r\n' || echo "UNKNOWN")

# Extract changed files from Gemini report
# We assume they are listed as bullet points under ## Changed Files
CHANGED_FILES=$(sed -n '/^## Changed Files/,/^##/p' "$GEMINI_REPORT" | grep '^- ' || echo "None reported")

# Extract Codex summary/findings if possible
# We'll take the first paragraph or list after the summary header if it exists
CODEX_FINDINGS=$(sed -n '/^## Summary/,/^##/p' "$CODEX_REPORT" | grep -v '^##' | sed '/^[[:space:]]*$/d' | head -n 5 || echo "No summary available")

RECOMMENDATION="NEEDS_FIX"
REASON="Verification stage completed."

if [[ "$NEXT_ACTION" == "READY_FOR_REVIEW" && "$CODEX_NEXT_ACTION" == "READY_FOR_REVIEW" ]]; then
  RECOMMENDATION="APPROVE"
  REASON="Both Gemini and Codex report READY_FOR_REVIEW."
elif [[ "$CODEX_NEXT_ACTION" == "BLOCKED" ]]; then
  RECOMMENDATION="BLOCKED"
  REASON="Codex reported BLOCKED status."
fi

cat <<EOF | tee "$FINAL_REPORT"
# Final Report

Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

## Pipeline Result

| Stage | Next Action |
|-------|------------|
| Gemini | $NEXT_ACTION |
| Codex | $CODEX_NEXT_ACTION |

## Recommendation

$RECOMMENDATION

Reason: $REASON

## Changed Files Summary

$CHANGED_FILES

## Codex Findings

$CODEX_FINDINGS
EOF

chmod +x scripts/ai/verify_after_gemini.sh
