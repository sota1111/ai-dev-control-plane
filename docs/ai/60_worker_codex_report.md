Completed SOT-629 debug/verification work.

Added the requested runner queue tests, updated `/queue` display coverage, made the minimal `/queue` grouping implementation change, and adjusted stale webhook test expectations for the current enqueue metadata signature.

Quality gate:
- `npm run lint` passed
- `npm test` passed: 9 suites, 125 tests

Report written to [docs/ai/60_worker_codex_report.md](/workspaces/ai-dev-control-plane/docs/ai/60_worker_codex_report.md). Unrelated `.tmp_ai-dev-test4/` was left untouched.
src/__tests__/discordCommandHandlers.test.js` — added assertions for priority display and parent/child grouping in `/queue`.
- `src/lib/discordCommandHandlers.js` — grouped child queue items under parent rows in `/queue` output.
- `src/__tests__/webhookServer.test.js` — updated enqueue expectations for priority/parent metadata arguments.
- `docs/ai/60_worker_codex_report.md` — this report.

## Commands Run
- `npm run lint` — pass, exit 0
- `npm test` — initially failed on parent/child test setup and stale webhook enqueue expectations; fixed minimally.
- `npm run lint` — pass, exit 0
- `npm test` — pass, exit 0 (`9` suites, `125` tests)

## Acceptance Criteria
- [x] 上記テストケースがすべて pass (runner.test.js)
- [x] /queue display tests pass (discordCommandHandlers.test.js)
- [x] npm run lint exit 0
- [x] npm test exit 0

## Risks
`npm test` still prints the existing development warning for missing `LINEAR_WEBHOOK_SECRET` and Jest's `--forceExit` open-handle hint, but the command exits 0. An unrelated untracked `.tmp_ai-dev-test4/` directory exists and was left untouched.

## Next Action
READY_FOR_REVIEW
