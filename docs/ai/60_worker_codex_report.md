Implemented SOT-572.

Changed:
- [scripts/ai/run_auto.sh](/workspaces/ai-dev-control-plane/scripts/ai/run_auto.sh:126): added `--model sonnet`
- [docs/ai/60_worker_codex_report.md](/workspaces/ai-dev-control-plane/docs/ai/60_worker_codex_report.md:1): wrote the requested worker report

Verification:
- `grep -n -- "--model sonnet" scripts/ai/run_auto.sh` passed
- `bash -n scripts/ai/run_auto.sh` passed
- `npm run lint` passed
- `npm test` passed: 9 suites, 108 tests
- `npm run lint` — passed
- `npm test` — passed; 9 test suites passed, 108 tests passed

## Acceptance Criteria
- [x] `scripts/ai/run_auto.sh` claude invocation includes `--model sonnet`
- [x] `bash -n scripts/ai/run_auto.sh` passes
- [x] `npm run lint` passes
- [x] `npm test` passes (or pre-existing-only failures, clearly noted)

## Risks
No known risks. Existing unrelated worktree changes were left untouched.

## Next Action
READY_FOR_REVIEW
