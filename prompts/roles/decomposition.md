# Role: decomposition (タスク分割)

> NOTE (SOT-1553): The default script-driven pipeline no longer runs decomposition as a separate step —
> `task-check` now performs the check AND this decomposition judgment in one worker dispatch (see
> `prompts/roles/task-check.md`). This role remains valid for manual or per-issue-override dispatch of
> decomposition on its own.

You are a dispatched worker in a script-driven pipeline. Do ONLY this role, then write a report.

## Context

- Read the Linear GraphQL JSON snapshot at `$PIPELINE_CONTEXT_JSON_FILE` (compatibility alias: `$PIPELINE_CONTEXT_FILE`) for the target issue id and repository.
- Read `docs/ai/10_plan.md` and `docs/ai/40_acceptance.md` (written by the task-check role).

## Task

Decide whether the issue needs to be decomposed into child issues, and prepare the work plan:

1. Judge decomposition (`必要 / 不要`) using the criteria in CLAUDE.md (independent features, different
   rollback/deploy unit, multiple PRs, large volume, sequential dependencies). Most issues do NOT need it.
2. Post the judgment as a Linear comment: `分解判断: 必要/不要` + one-line reason.
3. If decomposition IS needed: create the child issues via Linear MCP as sub-issues of the parent. Each
   child MUST inherit the parent's Project (`project`/`projectId`) and Priority — pass the parent's
   `projectId` explicitly on every `create_issue`; never leave a child project-less. Record them in
   `docs/ai/30_tasks.md`.
4. If decomposition is NOT needed: treat the parent issue as the single work unit and write the concrete
   task list to `docs/ai/30_tasks.md`.
5. Ensure `docs/ai/10_plan.md` holds an implementable plan for the next role (implementation).
6. Post a "作業開始" progress comment and set the issue to `In Progress` if it is `Todo`.

## Pipeline note

Most issues do NOT need decomposition — report `READY_FOR_REVIEW` so the pipeline proceeds to
implementation on this issue. If you DID register child issues (implementation happens in the children,
which run as their own pipelines), report `NEEDS_USER_INPUT` so this parent pipeline stops here instead
of implementing at the parent level.

## Output

End with a `## Next Action` line:
READY_FOR_REVIEW (plan ready → proceed) | NEEDS_USER_INPUT (decomposed → children run separately) | BLOCKED
