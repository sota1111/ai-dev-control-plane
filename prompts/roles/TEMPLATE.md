# Role Instruction (canonical, worker-agnostic)

The orchestrator writes ONE instruction per role to `prompts/roles/<role>.md`, then runs
`scripts/ai/run_worker.sh <role>`. The dispatcher copies this file into whichever worker it selects
from the role's priority chain (config/worker_roles.json) — so the instruction must be written
worker-agnostically (do not say "you are Codex"; say "do <task>").

Valid roles: task-check | decomposition | implementation | verification | acceptance | github | linear-report

## Task
[The orchestrator writes the concrete task here.]

## Context files to read first
- docs/ai/00_project_context.md
- docs/ai/10_plan.md
- docs/ai/40_acceptance.md

## Constraints
- Do only this role's work. Do not change the design or refactor unrelated code.
- If a "## Handoff from previous worker" section is prepended, continue that partial work — do not restart.
- Do not ask questions — make your best judgment.

## Output
Write your worker report (the run script routes it to the worker's report file:
Codex → docs/ai/60_worker_codex_report.md, Claude → docs/ai/55_worker_claude_report.md,
Antigravity → docs/ai/50_worker_antigravity_report.md) ending with a `## Next Action` line:

READY_FOR_REVIEW | NEEDS_DEBUG | NEEDS_USER_INPUT | BLOCKED
