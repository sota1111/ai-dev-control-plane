# Worker Report

## Summary
Task check for **SOT-933「N スロット並列ワーカープール（RUNNER_MAX_PARALLEL）を追加する」**.

**Worker non-response disclosure (audit sink):** the initial task check was delegated to Codex CLI
(`scripts/ai/run_codex.sh`) per policy, but Codex was **non-responsive** — exit code **75**
(`CODEX_COOLDOWN_ACTIVE`, usage-limit cooldown until epoch 1782000900, ~7.6h out). Gemini CLI is a
known permanently-ineligible tier (exit 75 IneligibleTierError). Per the Worker Non-Response Fallback
Policy, Claude Code performed this read-only task check directly. Implementation/verification for this
Issue likewise fall to Claude Code fallback while both workers are down.

**Verdict: SOT-933 is actionable and NOT already implemented.** It is the 3rd 案A implementation step
(after SOT-931 serialize-scope switch and SOT-932 worktree lane supply, both merged).

## Changed Files
- none (task check only)

## Commands Run
- `grep -rn "RUNNER_MAX_PARALLEL" src/` → only docs/plan references; **no code**. Not implemented.
- `grep -rn "acquireLock|drainQueue|RUNNER_LANE|RUNNER_SERIALIZE_SCOPE|laneKey" src/`
- Read `src/runner.ts` (drainQueue, acquireLock/releaseLock, resolveLane, serializationLaneKey,
  buildRunEnv, triggerRun, triggerRunDetached, runItem), `src/lib/worktree.ts`,
  `scripts/ai/run_auto.sh`, `src/__tests__/runner.test.ts`.

## Findings
- **Current serial bottleneck**: `drainQueue()` (runner.ts) is a strictly serial while-loop —
  dequeue → `acquireLock()` (single lane lock file) → `runItem()` → `releaseLock()`. The next item
  waits for the previous run's lock release.
- **Hard global serializer**: `scripts/ai/run_auto.sh` holds a FIXED global OS flock
  `/tmp/l-concierge-auto-run.lock` (line 49/68-72) — only ONE run_auto.sh can run system-wide,
  regardless of `RUNNER_LANE`. This is the real cross-process serialization point and MUST become
  lane-aware for N>1 to actually run concurrently.
- **Worktree lane supply (SOT-932) is wired**: `buildRunEnv()` calls `resolveLane(env)` and, for a
  non-default lane, repoints `WEBHOOK_TARGET_REPO` to a per-lane git worktree via
  `resolveLaneWorkingDir`. `buildRunEnv` reads lane from its `env` arg, so a per-dispatch env override
  (RUNNER_LANE) cleanly drives per-item worktree provisioning without mutating shared process.env.
- **Reuse points (do NOT rebuild)**: `runItem` already calls inflight/sentinel/`laneNotifier`
  (`notifyDetachedLaunched`) and the detached path; the reaper `reapCompletedDetachedRuns` +
  `processCompletedRun` already own completion. The pool only orchestrates dispatch.
- **Test pattern**: `src/__tests__/runner.test.ts` → `describe('parallel wait-task scenario (SOT-918)')`
  drives drainQueue with mocked Linear fetch + spied `triggerRunDetached`; new pool tests follow it.

## Acceptance Criteria
- [ ] RUNNER_MAX_PARALLEL=1 current-compatible — NOT met yet (flag does not exist). Design gates the
  pool behind `maxParallel>1` so N=1 keeps the exact serial path.
- [ ] N>1 frees queue waiting — NOT met yet. Requires pool dispatch + lane-aware OS flock.
- [ ] same branch stays serial — NOT met yet. Enforced by keying concurrency on the serialization
  lane (repo, or repo--branch under branch scope) so same-lane never dispatches concurrently.

## Risks
- run_auto.sh global flock must be made lane-aware (default lane → historical path for backward compat),
  else concurrent lanes collide on one flock and serialize anyway.
- Concurrency must NOT mutate shared `process.env` per item — pass per-dispatch env overrides through
  `runItem`→`triggerRun(Detached)`→`buildRunEnv` instead.
- Default N=1 must be byte-for-byte the current behavior to protect the 400+ existing tests.

## Next Action
READY_FOR_REVIEW
