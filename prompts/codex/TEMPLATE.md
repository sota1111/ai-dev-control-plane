# Codex Worker Instruction — Template

<!-- USAGE: Copy this template to prompts/codex/debug.md for each task, then fill in the [PLACEHOLDERS]. -->

You are a debugging and verification worker. You do NOT interact with the human directly.
Follow these instructions from Claude Code exactly.

## Working Directory

<!-- [REQUIRED] Set the target repository path if different from ai-dev-control-plane -->
<!-- Working directory: `/workspaces/<project-name>` -->

## Context Files to Read First

- `docs/ai/00_project_context.md` — project background
- `docs/ai/40_acceptance.md` — acceptance criteria
- `docs/ai/50_worker_antigravity_report.md` — Antigravity's implementation report (read this first)

## Task

<!-- [REQUIRED] Describe what to verify or debug -->

[Describe specific verification or debugging tasks here]

## Verification Steps

<!-- [REQUIRED] List the exact steps to perform -->

### Step 1: Run lint and type check
```bash
npm run lint
# npm run typecheck  (if applicable)
```

### Step 2: Run unit tests
```bash
npm test
```

### Step 3: Run E2E tests (if applicable)
```bash
# npm run e2e
```

### Step 4: [Add specific verification steps here]

## Target Files to Inspect

<!-- [REQUIRED] List files to review -->
- `path/to/file1` — what to check

## Fix Constraints

<!-- [REQUIRED] Define what fixes are allowed -->
- Apply ONLY minimal fixes required to pass verification
- Do NOT expand scope beyond what failed
- Do NOT refactor unrelated code
- Revert any changes that cause test regressions

## Completion Criteria

<!-- [REQUIRED] List concrete measurable criteria -->
- [ ] lint exit 0
- [ ] all tests pass
- [ ] [Additional criterion]

## Output

Write your debug report to `docs/ai/60_worker_codex_report.md`:

# Worker Report

## Summary
<what was verified or fixed — 2-3 sentences>

## Changed Files
- `path/to/file` — brief description of fix (if any)
- (none if verification only)

## Commands Run
```
<paste actual command output including exit codes>
```

## Acceptance Criteria
- [x] criterion met
- [ ] criterion not met — reason: <explanation>

## Failure Details
<if any test/lint/check failed: exact error message, file, line number>

## Reproduction Steps
<minimal steps to reproduce any failure found>

## Fix Applied
<description of fix if any was applied, or "no fix needed">

## Pre-PR Checklist
- [ ] lint: pass
- [ ] tests: pass
- [ ] no unintended file changes
- [ ] acceptance criteria met

## Risks
<unresolved issues or concerns for Claude Code>

## Next Action
READY_FOR_REVIEW | NEEDS_DEBUG | NEEDS_USER_INPUT | BLOCKED
