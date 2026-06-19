# Worker Report

## Summary
Initial task check for SOT-807 「動作再開」.
Codex CLI was NON-RESPONSIVE (`run_codex.sh` exit 75, usage-limit cooldown until epoch 1782000900 ≈ 2026-06-20, ~48h).
Per Worker Non-Response Fallback Policy, Claude Code performed the read-only task check directly.

**Determination: ACTIONABLE as an IMPLEMENT task (build the "reaper").**

The latest human instruction (2026-06-19 00:09, after reopening the issue Todo→reprocess) requests the
permanent fix flagged in the earlier completion report: a periodic Linear re-scan that re-enqueues
issues left stuck in `In Progress` / `usage-limit` after a cooldown clears.

## Findings
- SOT-807 current status: **In Progress** (set by Claude Code this run). Labels: none. Priority: High.
- Issue history: Todo → In Progress → Done (21:59) → reopened Todo (00:09:48). Latest human comment at
  00:09 asks to implement the reaper as the recurrence-prevention measure.
- Current drain architecture in `src/webhook-server.ts`:
  - `runPeriodicDrainTick()` (line 96) only inspects the **in-memory queue** via `hasDueQueueItem()`
    (`runner.loadQueue()`). It skips while locked, while in cooldown, and when no due item exists.
    It NEVER re-scans Linear. → If the in-memory queue is empty (process restarted, or stuck issue was
    never re-enqueued), stuck `In Progress` issues are invisible to the periodic drain.
  - `runBootstrapScan()` (line 408) DOES re-scan Linear (`runner.fetchActiveIssues(50)`) and enqueues
    active issues, but it runs **only once at startup** and is gated by `WEBHOOK_BOOTSTRAP_SCAN_ENABLED`.
    There is no periodic equivalent that runs after a cooldown clears.
- `runner.fetchActiveIssues()` (runner.ts:334) already returns Todo (`unstarted`) + In Progress
  (`started`) issues with archived filtered out — exactly the input a periodic reaper needs.
- Confirmed: **no existing periodic mechanism re-scans Linear to recover stuck issues.** This matches the
  human's diagnosis.

## Reaper integration point
Add a periodic Linear re-scan to the drain loop in `src/webhook-server.ts`:
- A reaper tick that, when NOT locked and NOT in cooldown, calls `runner.fetchActiveIssues()`, enqueues
  any active issue not already queued (reuse the `runBootstrapScan` enqueue loop / `runner.isQueued`),
  then drains. Mirror `runBootstrapScan`'s logic (syncQueueWithLinear → drainQueue) to avoid duplication.
- Trigger primarily on cooldown→clear transitions (and as a periodic safety net), so issues stranded
  during a cooldown are recovered automatically once usage-limit lifts.

## Changed Files
- none (read-only check)

## Commands Run
- `bash scripts/ai/run_codex.sh` → exit 75 (cooldown, non-responsive)
- `grep`/`Read` over `src/webhook-server.ts`, `src/runner.ts`

## Acceptance Criteria
- [x] SOT-807 actionable determination — ACTIONABLE (IMPLEMENT: reaper)
- [x] reaper integration point identified — periodic Linear re-scan in `src/webhook-server.ts` drain loop

## Risks
- Reaper must respect the lock and cooldown guards to avoid double-running tasks or hammering Linear.
- Avoid duplicate enqueues: reuse `runner.isQueued()` / `isQueuedOrRunning()`.
- Keep re-scan interval reasonable to limit Linear API load (reuse `QUEUE_DRAIN_INTERVAL_MS`).
- Should be guarded by an env flag (mirroring `WEBHOOK_BOOTSTRAP_SCAN_ENABLED`) so it can be disabled.

## Next Action
READY_FOR_REVIEW
