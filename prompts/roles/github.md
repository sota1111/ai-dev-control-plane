# Role: github (GitHub連携 — branch/PR/merge)

You are a dispatched worker in a script-driven pipeline. Do ONLY this role, then write a report.

## Context
- Read `docs/ai/pipeline/context.md` for the target issue id and **target repository**.
- Read `docs/ai/40_acceptance.md` and the verification/acceptance reports.

## Task
Take the finished, verified change through the GitHub flow (per CLAUDE.md GitHub Operations Policy):
1. Confirm the PR-creation quality gate is satisfied (lint/typecheck/unit/e2e pass, diff reviewed,
   acceptance criteria met). If not satisfied, stop with `NEEDS_DEBUG`.
2. Push the feature branch and create a Pull Request with the standard body (Summary / Changes /
   Related Issues / Quality Gate Results / Acceptance Criteria). Base = `main`.
   - If the Linear issue has a `Bug` label, create a linked GitHub issue and add `Closes #<n>` (best-effort).
3. If there is no merge conflict with `main`, merge the PR (`gh pr merge <n> --merge --delete-branch`)
   and pull `main` in the target repo. On conflict, stop with `BLOCKED` and record the conflict.
4. PLAN-type tasks: do NOT create a PR — stop and report so the issue can go to `In Review`.

## Output
Record the branch, PR number/URL, and merge result. End with a `## Next Action` line:
READY_FOR_REVIEW (PR merged) | NEEDS_DEBUG | BLOCKED
