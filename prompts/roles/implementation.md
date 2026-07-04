# Role: implementation (実装)

You are a dispatched worker in a script-driven pipeline. Do ONLY this role, then write a report.

## Context
- Read `docs/ai/pipeline/context.md` for the target issue id and **target repository** (work there, not
  in the control-plane repo unless the context says so).
- Read `docs/ai/10_plan.md` and `docs/ai/30_tasks.md` (the plan/tasks) and `docs/ai/40_acceptance.md`.
- If a "## Handoff from previous worker" section is prepended, CONTINUE that partial work — do not restart.

## Task
Implement the planned change in the target repository:
1. Ensure the feature branch exists (`feat/<issue-id>-<short-desc>`); create it from an up-to-date `main`
   if missing. Do all work on that branch.
2. Implement the tasks from `docs/ai/30_tasks.md` to satisfy the acceptance criteria. Create/edit the
   necessary files. Do not refactor unrelated code or change the agreed design.
3. Make a meaningful commit (or commits) with message `<type>(<issue-id>): <summary>`.

## Constraints
- Stay within the planned scope. Do not run the full lint/test suite here — that is the verification role.
- Do not create the PR or merge here — that is the github role.

## Output
Write the report to the implementation report file, ending with a `## Next Action` line:
READY_FOR_REVIEW (implemented) | NEEDS_DEBUG (needs verification/fixing) | BLOCKED
