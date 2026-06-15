Completed SOT-579 updates.

Changed:
- `README.md`: scheduler/webhook wording now describes queue enqueue/drain flow.
- `scripts/ai/scheduler.sh`: header comments updated to match `runner-cli.js` queue/drain behavior.
- `docs/ai/60_worker_codex_report.md`: worker report written.

Validation:
- `npm run lint`: PASS
- `npm test`: PASS, 9 suites / 113 tests

Note: existing untracked `.tmp_ai-dev-test4/` was present and left untouched.
pdated header comment

## Commands Run
- npm run lint: PASS
- npm test: PASS (9 test suites passed, 113 tests passed)

## Acceptance Criteria
- [x] README に「scheduler が直接 run_auto.sh を起動する」という古い記述がない
- [x] README に「webhook が直接 run_auto.sh を起動する」という古い記述がない
- [x] npm run lint が exit 0
- [x] npm test が exit 0、全テスト PASS

## Risks
None encountered. Remaining README references to `run_auto.sh` describe the runner itself, logs, retries, or failure cases rather than scheduler/webhook direct launch behavior.

## Next Action
READY_FOR_REVIEW
