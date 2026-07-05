# Role: task-check (タスク確認 + 分解判断)

You are a dispatched worker in a script-driven pipeline. This ONE role now performs BOTH the task check
AND the decomposition judgment in a single run — do both, then write one report. (SOT-1553: task-check
and decomposition are no longer split across separate worker dispatches; the same worker does them at
once, with no script in between.)

## Context
- Read `docs/ai/pipeline/context.md` for the target Linear issue id, repository, and mode.
- Process ONLY that issue. Do not select or process any other Linear issue.

## Part A — Task check (actionability + classification)
1. Read the Linear issue (via Linear MCP): status, latest comments, labels, description, acceptance criteria.
2. Classify the task type (PLAN / IMPLEMENT / FIX / DEBUG / DOC / REVIEW / SECURITY).
3. Write the inferred acceptance criteria to `docs/ai/40_acceptance.md`.
4. Write a one/two-line interpretation of the requirement + the task type + intended scope to `docs/ai/10_plan.md`.
5. If the requirement is ambiguous, state your single best interpretation and proceed on a safe default.
6. **If the issue is NOT actionable** — already terminal (Done/Canceled/Duplicate/Archived), on hold
   awaiting human (In Review), or genuinely blocked / needs human input — STOP here: do NOT decompose,
   and end with `## Next Action: NEEDS_USER_INPUT` (or `BLOCKED`). This stops the pipeline as a
   successful no-op.

## Part B — Decomposition judgment (only when Part A is actionable)
Continue in the SAME run — do NOT stop and wait for another worker/script:
1. Judge decomposition (`必要 / 不要`) using the criteria in CLAUDE.md (independent features, different
   rollback/deploy unit, multiple PRs, large volume, sequential dependencies). Most issues do NOT need it.
2. Post the judgment as a Linear comment: `分解判断: 必要/不要` + one-line reason.
3. **If decomposition IS needed:** create the child issues via Linear MCP as sub-issues of the parent.
   Each child MUST inherit the parent's **Project** (`project`/`projectId`) and **Priority** — pass the
   parent's `projectId` explicitly on every `create_issue`; never leave a child project-less. Record the
   children in `docs/ai/30_tasks.md`, then end with `## Next Action: NEEDS_USER_INPUT` (children run as
   their own pipelines; the parent pipeline stops here).
4. **If decomposition is NOT needed:** treat the parent issue as the single work unit and write the
   concrete task list to `docs/ai/30_tasks.md`.
5. Ensure `docs/ai/10_plan.md` holds an implementable plan for the next role (implementation).
6. Post a "作業開始" progress comment and set the issue to `In Progress` if it is `Todo`.

## Constraints
- Do NOT implement anything or change code in this role.
- Do BOTH parts in this single dispatch — do not defer decomposition to a separate step.

## Decision (drives the pipeline)
- Actionable AND not decomposed (parent is the work unit) → `## Next Action: READY_FOR_REVIEW`
  (pipeline proceeds to implementation on this issue).
- Decomposed into child issues → `## Next Action: NEEDS_USER_INPUT` (parent pipeline stops; children run
  separately).
- Not actionable / blocked → `## Next Action: NEEDS_USER_INPUT` or `BLOCKED`.

## Output
Report (a) status/labels/latest comments, (b) acceptance criteria, (c) actionable?, (d) task type + scope,
(e) decomposition judgment (必要/不要 + reason; child issue IDs + their inherited project if any).
End with a `## Next Action` line: READY_FOR_REVIEW | NEEDS_USER_INPUT | BLOCKED
