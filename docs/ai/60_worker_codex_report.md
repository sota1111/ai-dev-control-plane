# Worker Non-Response Fallback Disclosure (SOT-700 test-suite ESM migration)

Per CLAUDE.md "Worker Non-Response Fallback Policy", Claude Code performed the test-suite
ESM migration directly because both workers were non-responsive for that sub-task:

- **Codex CLI (DEBUG worker): non-responsive — usage/rate limit.** It successfully converted
  `src/webhook-server.ts` to ESM (verified below) but became rate-limited before migrating the
  Jest test suite.
- **Gemini CLI (IMPLEMENT worker): non-responsive across 2 passes.** First pass migrated the 6
  `.js` test files + `tsconfig` `isolatedModules`; second pass produced an empty report and made
  no further changes, leaving the 6 `jest.mock`-based suites unconverted.
- **Claude Code fallback:** converted the remaining suites (`sessionContinue`,
  `discordInteractionFollowup`, `discordAskHandler`, `runner`, `webhookServer`,
  `discordNotifierIntegration`) to `jest.unstable_mockModule` + dynamic `import()`, and resolved
  `@jest/globals` strict-typing issues. Final gate: `npm test` 21 suites / 258 tests pass,
  `npm run typecheck` exit 0, `npm run lint` exit 0.

---

Implemented the ESM conversion and wrote the report to [docs/ai/60_worker_codex_report.md](/workspaces/ai-dev-control-plane/docs/ai/60_worker_codex_report.md).

Verification:
- `npm run typecheck` exits 0
- `npm run lint` exits 0
- `timeout 15 npx tsx src/webhook-server.ts` reaches `[WEBHOOK] Server listening on port 3000`
- `npm test` still exits 1 because the existing Jest suite uses CommonJS `require` / global `jest` under the current ESM Jest config

Next action in the report is `NEEDS_DEBUG` due to the test-suite migration blocker.
fic issue IDs.
- `src/lib/discordCommandHandlers.ts` — converted imports to ESM.
- `src/lib/discordPauseState.ts` — converted imports to ESM.
- `src/lib/sessionContinue.ts` — converted imports to ESM.
- `src/lib/discordIntentHandlers.ts` — converted imports to ESM.
- `src/lib/discordInteractionFollowup.ts` — changed runner import to ESM namespace import.
- `src/lib/queueOrdering.ts` — widened queue item typing to accept nullable priority and issue identifier fields used by `runner.ts`.
- `src/lib/schedulerCore.js` — removed malformed duplicate export fragment blocking typecheck.
- `src/types/express.d.ts` — added minimal ambient declaration for `express`, which has no installed `@types/express`.
- `docs/ai/60_worker_codex_report.md` — worker report.

## Commands Run
- `npm run typecheck` — exit 0.
- `npm run lint` — exit 0.
- `timeout 15 npx tsx src/webhook-server.ts` — exit 124 from `timeout`; server reached `[WEBHOOK] Server listening on port 3000`, then received SIGTERM from timeout.
- `npm test` — exit 1. All suites fail at startup because the Jest ESM configuration runs tests that still use CommonJS globals (`require`, global `jest`).

## Acceptance Criteria
- [x] server starts without `require is not defined`
- [ ] typecheck / lint / test pass

## Risks
`npm test` is still blocked by the broader test-suite ESM migration: tests use CommonJS `require(...)` and global `jest` while the package runs Jest with `NODE_OPTIONS=--experimental-vm-modules` and `ts-jest/presets/default-esm`.

## Next Action
NEEDS_DEBUG
