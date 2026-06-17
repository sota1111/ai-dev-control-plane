# Worker Report

> ⚠️ Worker Non-Response Fallback: This initial task check was delegated to **Codex CLI**
> (`scripts/ai/run_codex.sh`), which exited with the dedicated non-response code **75**
> (Codex usage-limit cooldown active, `docs/ai/auto_logs/codex.cooldown.json`
> resumeAtEpoch=1782000900, ~3 days out). The cooldown pre-check skips the CLI deterministically,
> so an immediate retry is futile. Per the Worker Non-Response Fallback Policy, **Claude Code
> performed this task check directly**. Failure mode: usage-limit cooldown (CODEX_COOLDOWN_ACTIVE).

## Summary
SOT-744 is **actionable**. Status In Progress, priority High, no labels, no comments, no
explicit acceptance criteria in the description (criteria derived below).

The issue asks: before executing a task, re-check Linear priorities and reorder the queue so the
highest-priority actionable issue runs first — because priority-only changes do not reliably fire
Linear webhooks, so a freshly-raised Urgent/High issue can be starved behind a lower-priority
webhook-triggered run.

**Exact code gap:** at execution time the runner orders the queue purely on the priority captured
**at enqueue time** (from the webhook payload, stored as `priority`/`priorityRank` in the queue
item). It never re-fetches the latest Linear priority for queued items, and `syncQueueWithLinear`
only *removes* terminal/archived issues — it neither refreshes priorities nor pulls in
higher-priority pending (Todo/In Progress) issues that never fired a webhook. So `dequeue` /
`drainQueue` can run a stale lower-priority item ahead of a now-higher-priority one.

## Changed Files
- none (task check only)

## Commands Run
- `npm run lint` → exit 0 (pass)
- `npm run typecheck` → exit 0 (pass)
- `npm test` → exit 0 (pass): 21 suites, 261 tests passed

## Findings
- **Linear**: SOT-744 In Progress, High priority, no labels, no comments, no explicit AC block.
- **Execution-time queue selection path**:
  - `src/webhook-server.ts:236-317` — webhook handler: `enqueue` (priority from
    `body.data.priority`) → `dequeue()` → `acquireLock` → `runItem`, then `drainQueue`.
  - `src/runner.ts:941` `dequeue()` → delegates ordering to
    `queueOrdering.selectNextReadyIndex` using each item's stored `priority`/`priorityRank`.
  - `src/runner.ts:854` `enqueue()` stamps `priorityRank = getPriorityRank(priority)` from the
    value passed in (webhook payload) — never refreshed afterward.
  - `src/runner.ts:724` `syncQueueWithLinear()` — removes not-found/archived/terminal only; does
    NOT refresh priority and does NOT add new issues.
  - `src/runner.ts:1379` `drainQueue()` — calls `dequeue` in a loop on the local queue only.
  - `src/runner.ts:331` `fetchActiveIssues()` — already fetches `priority` + state for all active
    issues (used by bootstrap scan); a good building block for refresh/pull-in.
  - `src/lib/queueOrdering.ts` — `selectNextReadyIndex`/`effectiveRank`/`getPriorityRank` ordering
    is sound; it just needs fresh priority inputs.
- **Re-fetch latest priority before execution?** No.
- **Pull in non-webhook higher-priority pending issues?** No.

## Decomposition Recommendation
**One PR, no child issues.** Single cohesive feature on the queue/runner refresh path
(`runner.ts` + a focused unit test). Clear approach, one rollback unit.

## Acceptance Criteria
- [ ] Before executing a queued/webhook-triggered item, the runner refreshes queued items' priority
      from Linear (latest priority wins over the enqueue-time value).
- [ ] Higher-priority pending issues in Linear that did not fire a webhook are considered, so the
      highest-priority actionable issue runs first.
- [ ] Ordering remains deterministic and starvation-free (Urgent-first, then rank → tiebreakers).
- [ ] lint / typecheck / test all pass, with unit coverage for the new refresh/reorder behavior.

## Risks
- **Linear API cost / rate limits**: refreshing priorities adds queries before each run; bound the
  fetch (reuse `fetchActiveIssues(first)`) and fail-open (never block execution on API error),
  matching existing `hasPendingIssues`/`syncQueueWithLinear` behavior.
- **Fail-open**: on API failure, fall back to the stored priority order rather than blocking.
- **Starvation**: ensure tiebreakers (`retryAt`, `enqueuedAt`) still apply so equal-priority items
  don't livelock.
- **In-flight/lock interplay**: do not reorder/preempt an item already running under the lock;
  only affect selection of the NEXT item.

## Next Action
READY_FOR_REVIEW
