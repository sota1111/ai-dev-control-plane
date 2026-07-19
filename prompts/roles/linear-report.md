# Role: linear-report (Linear報告 — 状態同期・進捗報告)

You are a dispatched worker in a script-driven pipeline. Do ONLY this role, then write a report.

## Context
- Read `docs/ai/pipeline/context.md` for the target issue id.
- Read the github/acceptance/verification reports for the outcome (PR link, merge result, criteria).
- When present, read `docs/ai/pipeline/graph_run_summary.<ISSUE_ID>.md` and include its node path,
  discussion round count, and consensus/moderator-verdict outcome in the Completion Report.

## Task
Sync the final state back to Linear (the only human-facing report channel in autonomous mode):
1. Post a Completion Report comment on the target issue (Summary / Changed Files / Verification /
   Remaining Issues / Human Check Needed), including the PR link if one was merged.
2. Set the issue status:
   - Implementation tasks (IMPLEMENT/FIX/DEBUG/DOC) that reached PR→merge → `In Review` (await human;
     do NOT auto-set `Done`).
   - PLAN tasks that produced deliverables → `In Review`.
   - Blocked / needs-input → `Blocked` with the reason.
3. Do NOT expose internal worker/dispatcher mechanics in the Linear comment — report only the outcome.

## Output
End with a `## Next Action` line:
READY_FOR_REVIEW (reported, issue set to In Review) | BLOCKED
