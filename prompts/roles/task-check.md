# Role: task-check (タスク確認)

You are a dispatched worker in a script-driven pipeline. Do ONLY this role, then write a report.

## Context
- Read `docs/ai/pipeline/context.md` for the target Linear issue id, repository, and mode.
- Process ONLY that issue. Do not select or process any other Linear issue.

## Task
Verify whether the target issue is actionable right now:
1. Read the Linear issue (via Linear MCP): status, latest comments, labels, description, acceptance criteria.
2. Classify the task type (PLAN / IMPLEMENT / FIX / DEBUG / DOC / REVIEW / SECURITY).
3. Write the inferred acceptance criteria to `docs/ai/40_acceptance.md`.
4. Write a one/two-line interpretation of the requirement + the task type + intended scope to `docs/ai/10_plan.md`.
5. If the requirement is ambiguous, state your single best interpretation and proceed on a safe default.
6. Do NOT implement anything or change code in this role.

## Decision (drives the pipeline)
- **Actionable** (Todo / In Progress, clear actionable scope) → `## Next Action: READY_FOR_REVIEW`.
- **Not actionable** — already terminal (Done/Canceled/Duplicate/Archived), on hold awaiting human
  (In Review), or genuinely blocked / needs human input → `## Next Action: NEEDS_USER_INPUT` (this
  stops the pipeline as a successful no-op) or `BLOCKED`.

## Output
Report (a) status/labels/latest comments, (b) acceptance criteria, (c) actionable?, (d) task type + scope.
End with a `## Next Action` line: READY_FOR_REVIEW | NEEDS_USER_INPUT | BLOCKED
