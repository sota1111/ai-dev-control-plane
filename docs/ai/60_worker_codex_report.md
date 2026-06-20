# Worker Report

## Summary
Initial task check for SOT-914 "long-run issueのデタッチ実行モードを追加する" (child of SOT-911, 案② / SOT-792 §4-2).

**Codex was non-responsive** (run_codex.sh exit 75: usage-limit cooldown until epoch 1782000900, ~15h out).
Per Worker Non-Response Fallback Policy, a usage-limit cooldown is not resolved by retry, so
Claude Code performed this read-only task check directly.

Verdict: **ACTIONABLE.** Dependency SOT-913 (lane-aware lock/queue paths, RUNNER_LANE) is merged on main
(PR #111). Scope is clear (2 files), baseline is green.

## Changed Files
- none (task check)

## Commands Run
- TARGET_REPO=/workspaces/ai-dev-control-plane bash scripts/ai/run_codex.sh → exit 75 (cooldown, non-responsive)
- npm run lint → exit 0
- npm run typecheck → exit 0
- npm test → exit 0 (all suites pass)
- grep / file reads (Claude fallback investigation)

## Findings (for implementer)
- **Lock acquire/release**: `acquireLock()` runner.ts:168, `releaseLock()` runner.ts:215, `isLocked()` :268,
  `forceReleaseLock()` :236. JS lock file = `LOCK_FILE` (lane-aware via SOT-913). Note: run_auto.sh ALSO holds
  a separate global OS flock that serializes the heavy claude runs.
- **runItem execution model**: runner.ts:1748 — `runItem` calls `triggerRun` (:1610) which `spawn`s
  `scripts/ai/run_auto.sh` `detached:true` BUT awaits `child.on('close')` (:1686-1701), i.e. the promise
  resolves only when the run *finishes*. The caller holds the JS lock the whole time → "lock hold = sim time".
- **drainQueue** (runner.ts:1876): acquireLock → try{ addInflight, setCurrentIssue, runItem } finally{
  clearCurrentIssue, removeInflight, releaseLock }. So inflight + lock are tied to the synchronous run lifetime.
- **webhook-server dispatch** (webhook-server.ts:465-494): dequeue → acquireLock → `runItem(item)` →
  finally releaseLock + drain. Webhook path does NOT addInflight (only drainQueue does).
- **inflight / sentinel / reaper**: `InflightEntry{issueId, startedAt}` runner.ts:1248; `addInflight` :1356,
  `removeInflight`, `loadInflightRecords` :1255, `saveInflightRecords` :1273, `reapStaleInflight()` :1300
  (no-op while `isLocked()`, clears entries older than `INFLIGHT_TTL_MS`=2h or null startedAt). `INFLIGHT_FILE`
  = runner.inflight.json. CURRENT_ISSUE_FILE = current-issue.json.
- **Recommended long-run detection**: a Linear label, env-configurable `LONG_RUN_LABEL` (default `long-run`).
  Detected by querying the issue's labels via the existing `linearQuery` helper (same path as
  `getIssueExecutionEligibility`). Fail-closed (treat as normal/synchronous) on API error so behavior is
  unchanged when Linear is unreachable.

## Design (Claude, for implementation)
1. Add `RUN_RESULT.DETACHED` + `isLongRunIssue(issueId)` (label lookup, env `LONG_RUN_LABEL`, fail-closed).
2. Add `triggerRunDetached(issueId)`: spawn run_auto.sh `detached:true`, `stdio:'ignore'`, `child.unref()`,
   resolve immediately with the child pid (does NOT await close).
3. Add a per-issue **sentinel** file (`detached/<issueId>.json` under LOG_DIR: {issueId, pid, startedAt})
   written at detached launch; reaper clears stale/dead-pid sentinels alongside leaked inflight.
4. `runItem`: when long-run, `addInflight` (idempotent) + write sentinel + `triggerRunDetached`, return a
   structured outcome `{lockConflict:false, detached:true}`. Normal issues keep the synchronous path.
5. drainQueue/webhook: on `detached`, release the lock immediately but KEEP inflight (reaper owns cleanup).
6. Keep `runItem`'s boolean-compatible contract by returning an object both callers read.

## Acceptance Criteria
- [x] Issue status/labels/comments confirmed (Todo→In Progress; no labels; no comments)
- [x] Baseline lint/typecheck/test status reported (all green)
- [x] Actionability verdict given (ACTIONABLE)

## Risks
- run_auto.sh's global OS flock still serializes the heavy claude run; SOT-914 only removes the JS-lock
  serialization (lock hold ≈ startup time). True cross-lane parallelism is the broader SOT-911 umbrella.
- Detached runs lose synchronous output → no usage-limit classification for that run; the reaper + sentinel
  are the safety net. Acceptable for long-run mode.

## Next Action
READY_FOR_REVIEW
