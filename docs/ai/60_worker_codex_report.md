# Worker Report

## Summary
Initial task check for SOT-810 (now IMPLEMENT phase). Human selected proposals **1, 2, 4, 5**
(proposal 3 deferred to SOT-792); proposal 5 must post to the NOTIFY Discord webhook.

**Worker non-response disclosure:** Codex CLI was delegated this task check
(`scripts/ai/run_codex.sh`) but returned exit 75 (usage-limit cooldown until epoch
1782000900, ≈2026-06-20). Per CLAUDE.md Worker Non-Response Fallback Policy, Claude Code
performed this read-only verification directly.

## Codebase verification (all facts confirmed)

### 提案1 — default-enable webhook bootstrap scan ✅
- `runBootstrapScan()` at `src/webhook-server.ts:498-534`.
- Gated at line 499: `process.env.WEBHOOK_BOOTSTRAP_SCAN_ENABLED === 'true'` → **default disabled**.
- Reaper uses the opposite default convention (line 144: `WEBHOOK_REAPER_ENABLED === 'false'` → default enabled).
- Change surface: flip the gate to `!== 'false'` so startup scan runs by default; update tests/README/.env.example.

### 提案2 — leaked-inflight TTL reaper ✅
- `runner.inflight.json` (`src/runner.ts:96` INFLIGHT_FILE). `loadInflight()` (1050) returns a **`string[]`** of issueIds — **no `startedAt`/PID**.
- `isQueuedOrRunning()` (1125) = `isQueued || isInflight`; a leaked inflight entry blocks the issue forever.
- Lock has staleness handling already (`isLocked()` :197, `STALE_LOCK_MS`, PID `process.kill(pid,0)`), but inflight does not.
- Change surface: give inflight entries a `startedAt` (schema migration tolerant of legacy string[]), then add TTL+`!isLocked()` cleanup to `runReaperTick` / startup.

### 提案4 — idempotent enqueue ✅
- `enqueue()` at `src/runner.ts:910`; scan guards with `isQueued()` (`webhook-server.ts:118`, runner.ts:1045).
- Race window remains between bootstrap scan and webhook on restart.
- Change surface: make `enqueue()` idempotent (same identifier → update priority/retryAt instead of duplicate); add tests for bootstrap↔webhook boundary.

### 提案5 — startup/recovery summary to NOTIFY Discord ✅
- NOTIFY webhook env var is `DISCORD_WEBHOOK_URL_NOTIFY`; helper `resolveNotifyWebhook(notify, fallback)` in `src/lib/cooldownNotifier.ts:7` (pattern: `resolveNotifyWebhook(getSecret('DISCORD_WEBHOOK_URL_NOTIFY'), getSecret('DISCORD_WEBHOOK_URL'))`).
- Bootstrap/reaper currently emit logs only (`runner.log('BOOTSTRAP'/'REAPER', ...)`).
- Change surface: post a one-line summary (counts + target issues + next drain) of bootstrap scan and reaper recovery to the NOTIFY webhook.

## Existing tests
- `src/__tests__/webhookServer.test.ts:589` (`runBootstrapScan`), `:684` (`runReaperTick`) — solid base to extend.

## Changed Files
- none (read-only task check)

## Commands Run
- `bash scripts/ai/run_codex.sh` → exit 75 (codex usage-limit cooldown; fell back to Claude)
- grep/sed/read over `src/webhook-server.ts`, `src/runner.ts`, `src/lib/cooldownNotifier.ts`

## Acceptance Criteria
- [x] Issue is actionable (human selected proposals 1,2,4,5; proposal 5 → NOTIFY webhook)
- [x] Current webhook startup behavior re: Todo/In Progress determined (exists, default-disabled)
- [x] Relevant files identified
- [x] Change surface for each selected proposal confirmed

## Risks
- 提案2 requires an inflight schema change; keep backward-compat with legacy `string[]` file.
- 提案5 must use `DISCORD_WEBHOOK_URL_NOTIFY` (NOTIFY), not the general `DISCORD_WEBHOOK_URL`.
- Linear free-plan issue cap may block child-issue creation; archive if needed.

## Next Action
READY_FOR_REVIEW
