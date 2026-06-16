# Worker Report

## Summary
Verified SOT-658. No code fixes were required. Lint exits 0, Jest passes with no regression versus the 13 suites / 189 tests baseline, and static review confirms immediate Discord ACK plus background follow-up behavior.

## Changed Files
- `docs/ai/60_worker_codex_report.md` - verification report only

## Commands Run
- `cd /workspaces/ai-dev-control-plane && npm run lint`
  - Exit code: 0
  - Tail:
    ```text
    > ai-dev-control-plane@1.0.0 lint
    > node --check src/runner.js && node --check src/runner-cli.js && node --check src/webhook-server.js && node --check src/lib/usageLimitParser.js && node --check src/lib/discordNotifier.js && node --check src/lib/issueClassifier.js && node --check src/lib/discordInteractions.js && node --check src/lib/discordCommandRouter.js && node --check src/lib/discordCommandHandlers.js && node --check src/lib/discordPauseState.js && node --check src/lib/discordAskHandler.js && node --check src/lib/discordIntentClassifier.js && node --check src/lib/discordIntentHandlers.js && node --check src/lib/discordInteractionFollowup.js && node --check scripts/register_discord_commands.js && node --check scripts/auth/firebase-user.js && node --check scripts/auth/cloudrun-sync.js && node --check scripts/auth/auth-setup.js && node --check src/lib/resumeMetadata.js && node --check src/lib/sessionContinue.js && node --check src/session-continue-cli.js
    ```
- `cd /workspaces/ai-dev-control-plane && npm test`
  - Exit code: 0
  - Summary:
    ```text
    Test Suites: 14 passed, 14 total
    Tests:       194 passed, 194 total
    Snapshots:   0 total
    Time:        2.401 s, estimated 3 s
    Ran all test suites.
    ```
  - Note: Jest still prints the existing `LINEAR_WEBHOOK_SECRET` development warning in `webhookServer.test.js`; the suite passes.
- `git status --short && git branch --show-current && git diff --name-only main...HEAD && git diff --name-only`
  - Exit code: 0
  - Tail:
    ```text
     M docs/ai/60_worker_codex_report.md
     M package.json
     M src/__tests__/discordAskHandler.test.js
     M src/lib/discordAskHandler.js
    ?? src/__tests__/discordInteractionFollowup.test.js
    ?? src/lib/discordInteractionFollowup.js
    feat/SOT-658-discord-ask-immediate-ack
    docs/ai/60_worker_codex_report.md
    package.json
    src/__tests__/discordAskHandler.test.js
    src/lib/discordAskHandler.js
    ```
- `git diff --name-status main...HEAD && git status --short`
  - Exit code: 0
  - Tail:
    ```text
     M docs/ai/60_worker_codex_report.md
     M package.json
     M src/__tests__/discordAskHandler.test.js
     M src/lib/discordAskHandler.js
    ?? src/__tests__/discordInteractionFollowup.test.js
    ?? src/lib/discordInteractionFollowup.js
    ```

## Acceptance Criteria
- [x] npm run lint exit 0
- [x] npm test pass (no regressions)
- [x] immediate ACK returned before background work (3s deadline respected)
- [x] background never throws / unhandled rejection; followup never throws
- [x] editOriginalInteractionResponse: PATCH @original, 429 retry-once, missing-token guard
- [x] no new secret/env var/dependency; router & webhook unchanged
- [x] only expected files changed

## Static Review Notes
- `handleAskModalSubmit` validates empty and over-length input synchronously, then starts `processAskInBackground(interaction, inputText)` without awaiting it. It returns the ephemeral type 4 ACK immediately and attaches `followupPromise` to the returned object.
- `processAskInBackground` wraps classification, handler dispatch, and follow-up edit in `try/catch`. Error paths log `DISCORD_ASK` and attempt to edit the original interaction with `❌ エラーが発生しました。`.
- `editOriginalInteractionResponse` uses built-in `https`, method `PATCH`, host `discord.com`, and path `/api/v10/webhooks/{applicationId}/{interactionToken}/messages/@original` with JSON `{content}`. It truncates long content to 1990 chars plus `…`, retries once on HTTP 429, resolves `{status, body}`, and returns `{status: 0, body: ''}` before making a request if application id or token is missing.
- Existing `runner.log('DISCORD_ASK', ...)` flow is preserved; `response sent` now logs `{ mode: 'deferred', status: 200 }`. Input and response previews still use `sanitizeDiscordAskLogText`.
- `package.json` only adds the new follow-up helper to the lint chain. No new runtime dependency, environment variable, or secret was introduced.
- `discordCommandRouter.js` still returns handler results, and `webhook-server.js` destructures only `{ status, body }` before responding, so the extra `followupPromise` property is ignored by HTTP response serialization.
- Changed/untracked paths are within the expected allowlist: `src/lib/discordInteractionFollowup.js`, `src/lib/discordAskHandler.js`, `src/__tests__/discordAskHandler.test.js`, `src/__tests__/discordInteractionFollowup.test.js`, `package.json`, and `docs/ai/60_worker_codex_report.md`.

## Risks
- Jest uses `--forceExit` and prints its standard open-handle suggestion; no failing test or observed regression.
- `git diff --name-only main...HEAD` does not show untracked files, so untracked expected files were checked with `git status --short`.

## Next Action
READY_FOR_REVIEW
