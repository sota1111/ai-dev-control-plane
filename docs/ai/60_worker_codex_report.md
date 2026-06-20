# Worker Report

## Summary
Initial task check for SOT-925 "タスク開始時間と終了時間まとめ" (reopened FIX task).
Codex CLI was non-responsive (usage-limit cooldown — `run_codex.sh` exited 75, reset
≈ epoch 1782000900, ~12h out), so per the **Worker Non-Response Fallback Policy** Claude Code
performed the task check directly.

Findings confirmed by direct code reading:
- Detached path (`src/runner.ts`): `getIssueExecutionEligibility` sets `isLongRun` from the
  `long-run` label (line ~1816); `runItem` routes `isLongRun` issues to `triggerRunDetached`
  and releases the lock immediately (lines ~2071-2081); `reapCompletedDetachedRuns` (line ~1377)
  post-processes detached completion via `processCompletedRun`. CONFIRMED.
- Reaper starvation (`src/webhook-server.ts` `runReaperTick`): the Linear re-scan
  `scanAndEnqueueActiveIssues('webhook-reaper')` is skipped when a run is active OR the in-memory
  queue has a due item — gate `if (!cooldownJustCleared && hasDueQueueItem()) return;` (line ~178).
  A continuously busy queue can therefore starve recovery of stranded In-Progress issues
  (deviation 1's mechanism). CONFIRMED.
- Wait/long tasks without the `long-run` label run on the synchronous path and occupy the single
  lane for their whole duration → wall-clock inflation (deviation 2). CONFIRMED.

## Changed Files
- none (read-only check)

## Commands Run
- `TARGET_REPO=/workspaces/ai-dev-control-plane bash scripts/ai/run_codex.sh` → exit 75 (cooldown, non-responsive)
- `npm run lint` → exit 0
- `npm run typecheck` → exit 0
- `npm test` → exit 0 (402 passed / 402 total)

## Acceptance Criteria
- [x] detached path (long-run → triggerRunDetached → reapCompletedDetachedRuns) confirmed w/ line refs
- [x] reaper starvation gate (hasDueQueueItem) confirmed w/ line refs
- [x] baseline lint/typecheck/test reported (all green, 402 tests)

## Risks
- Codex unavailable ~12h; subsequent verification in this run is Claude fallback (disclosed here).

## Next Action
READY_FOR_REVIEW
