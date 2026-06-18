# Worker Report

## Summary
Initial task check for SOT-809 「Botの/queueが応答しない」. Codex CLI was NON-RESPONSIVE
(exit 75, usage-limit cooldown until epoch 1782000900 ≈ 2026-06-20, ~49h out). Per Worker
Non-Response Fallback Policy, Claude Code performed the read-only task check directly.

Issue is ACTIONABLE: status In Progress, no labels, no comments, no blockers.

**Most likely root cause of the `/queue` timeout:**
The Discord interaction HTTP response is sent only after `routeInteraction` resolves
(`src/webhook-server.ts:393-397`). `/status` (`handleStatus`) is fully synchronous — it
only reads local state (lock, queue file, cooldown, pause, session) — so it ACKs well
within Discord's 3-second deadline. `/queue` (`handleQueue`) performs `await
runner.fetchActiveIssues()` (a Linear GraphQL network call) BEFORE returning the response.
When that network call is slow (or Linear is rate-limited/unreachable), the response
exceeds the 3s ACK deadline and Discord shows "アプリケーションが応答しませんでした".

## Fix model (existing pattern)
`/ask` already solves this: it returns an immediate response and does slow work in the
background, then PATCHes `@original` via
`src/lib/discordInteractionFollowup.ts::editOriginalInteractionResponse`. The same
deferred-response pattern (Discord interaction response type 5,
DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE) should be applied to `/queue`: ACK immediately,
then compute the queue (including `fetchActiveIssues`) in the background and edit the
original response with the result.

## Changed Files
- none (read-only task check)

## Commands Run
- `bash scripts/ai/run_codex.sh` → exit 75 (codex usage-limit cooldown, non-responsive)
- Read `src/lib/discordCommandHandlers.ts`, `src/lib/discordCommandRouter.ts`,
  `src/webhook-server.ts`, `src/lib/discordAskHandler.ts`,
  `src/lib/discordInteractionFollowup.ts`

## Acceptance Criteria
- [x] Issue status/comments/labels/actionability confirmed (actionable)
- [x] Root cause of `/queue` timeout identified (blocking network call before ACK)
- [x] Request path confirmed (synchronous response in webhook-server)
- [x] Candidate fix model identified (deferred response like `/ask`)

## Risks
- Deferred responses (type 5) change `/queue` UX slightly: shows "thinking…" then the
  result. Acceptable and consistent with `/ask`.
- Must keep ephemeral flag (64) on the deferred response to match current behavior.

## Post-fix verification (Claude Code fallback — Codex non-responsive)
Codex remained non-responsive (usage-limit cooldown, exit 75), so Claude Code ran the
quality gate directly per the Fallback Policy:
- `npm run lint` → exit 0
- `npm run typecheck` → exit 0
- `npm test` → 24 suites / 305 tests passing (incl. new `discordCommandRouter.test.ts`)
- `npm run e2e` → N/A (no e2e script in package.json)

## Next Action
READY_FOR_REVIEW
