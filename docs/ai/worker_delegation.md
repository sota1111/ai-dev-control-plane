# Worker Delegation Flow

## Overview

Claude Code is the sole orchestrator. Gemini CLI and Codex CLI are workers.
Humans interact only with Claude Code — never directly with workers.

## Role Assignments

### Claude Code (Orchestrator)

**Responsibilities:**
- Reading and classifying Linear Issues
- Judging whether child Issue decomposition is needed
- Writing worker instruction prompts
- Reviewing worker reports
- Final quality gate decisions
- GitHub operations (branch, PR, merge)
- Linear state sync

**Claude Code does NOT:**
- Write multi-file implementation code
- Run lint/test/typecheck cycles directly
- Perform long-running log analysis
- Do first-pass PR diff reviews

**Claude Code MAY directly perform:**
- 1-2 line wording fixes
- Linear comments and status updates
- PR creation and merge
- Final report writing

### Gemini CLI (Implementation Worker)

**Trigger:** All `[IMPLEMENT]` tasks, new features, multi-file changes, large doc rewrites

**Receives:** `prompts/gemini/implement.md` (written by Claude Code)

**Produces:** `docs/ai/50_worker_gemini_report.md`

**Must include in instructions:**
- Working directory
- Target files (explicit list)
- Allowed change scope
- Prohibited actions
- Verification commands to run
- Completion criteria

**Must include in report:**
- Summary of implementation
- Changed files list
- Commands run with output
- Acceptance criteria check
- Unverified items (for Codex)
- Codex verification points
- Next action

### Codex CLI (Verification Worker)

**Trigger:** After Gemini implementation, all `[DEBUG]` tasks, test failures, lint failures, security checks, PR diff reviews

**Receives:** `prompts/codex/debug.md` (written by Claude Code)

**Produces:** `docs/ai/60_worker_codex_report.md`

**Must include in instructions:**
- Verification steps (lint, test, e2e)
- Target files to inspect
- Fix constraints (minimal fixes only)
- Completion criteria

**Must include in report:**
- Verification results
- Failure logs with exact errors
- Reproduction steps
- Fix applied (if any)
- Pre-PR checklist
- Next action

## Task Type → Worker Mapping

| Task Type | Primary Worker | Notes |
|-----------|---------------|-------|
| IMPLEMENT | Gemini CLI | Always delegate; never implement directly |
| FIX | Codex CLI | Small fixes |
| DEBUG | Codex CLI | Test failures, log analysis |
| PLAN | Claude Code → Gemini (if needed) | Claude Code designs, Gemini implements |
| DOC | Codex CLI (small) / Gemini CLI (large) | |
| REVIEW | Codex CLI → Claude Code (final) | |
| SECURITY | Codex CLI → Claude Code (final) | |

## Delegation Decision Rules

### Delegate to Gemini when:
- New feature implementation across multiple files
- New module/class/component creation
- Test file creation
- Large documentation rewrites
- Multi-file refactoring with clear spec

### Delegate to Codex when:
- Running lint/typecheck/tests
- Investigating test failures
- Analyzing error logs
- Verifying Gemini's implementation
- PR diff review
- Security/credential checks
- Minimal bug fixes (1-2 lines, clear cause)

### Handle in Claude Code when:
- Requires judgment about scope or requirements
- Multiple repos or control-plane systems involved
- queue/lock/webhook/usage-limit orchestration changes
- Issue decomposition decisions
- Final approval and merge

## Worker Failure Re-Delegation

1. Gemini implementation → test failure: Re-delegate to Codex as DEBUG
2. Codex fix → spec mismatch: Re-delegate to Gemini as IMPLEMENT or PLAN
3. 2+ consecutive failures: Set Issue to Blocked, post reason to Linear

## Script Reference

| Script | Purpose | Output |
|--------|---------|--------|
| `scripts/ai/run_gemini.sh` | Run Gemini implementation worker | `docs/ai/50_worker_gemini_report.md` |
| `scripts/ai/run_codex.sh` | Run Codex debug/verification worker | `docs/ai/60_worker_codex_report.md` |

### run_gemini.sh behavior:
- Reads prompt from: `prompts/gemini/implement.md`
- If `TARGET_REPO` is set: passes `--include-directories $TARGET_REPO`
- Output: written to `docs/ai/50_worker_gemini_report.md` AND stdout

### run_codex.sh behavior:
- Reads prompt from: `prompts/codex/debug.md`
- If `TARGET_REPO` is set: `cd $TARGET_REPO` before running
- Output: written to `docs/ai/60_worker_codex_report.md` AND stdout

## Workflow Sequence

```
1. Claude Code: Read & classify Linear Issue
2. Claude Code: Write prompts/gemini/implement.md
3. run_gemini.sh → Gemini implements
4. Claude Code: Read docs/ai/50_worker_gemini_report.md
5. Claude Code: Write prompts/codex/debug.md
6. run_codex.sh → Codex verifies
7. Claude Code: Read docs/ai/60_worker_codex_report.md
8. Claude Code: Quality gate check
9. Claude Code: git add/commit, push, create PR, merge
10. Claude Code: Update Linear status, post Completion Report
```
