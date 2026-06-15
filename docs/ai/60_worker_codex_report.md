Completed SOT-572.

Changed:
- [README.md](/workspaces/ai-dev-control-plane/README.md:757): replaced the simple migration list with the requested per-app authentication table.
- [docs/ai/60_worker_codex_report.md](/workspaces/ai-dev-control-plane/docs/ai/60_worker_codex_report.md:1): wrote the worker report.

Verification:
- `npm run lint` passed.
- `npm test` passed: 9 suites, 108 tests.

Note: existing unrelated working tree changes remain untouched: `.claude/settings.local.json`, `.tmp_ai-dev-test4/`.
h-phrase\|stock-signal\|state-machine\|shrine-stair\|kindle-sale\|booking-monitor\|toddler" /workspaces/ai-dev-control-plane/README.md | tail -30`
  - Result: pass. Confirmed the old simple list existed at lines 757-771.
- `grep -n -A 20 "### 移行状況" /workspaces/ai-dev-control-plane/README.md`
  - Result: pass. Confirmed the new per-app authentication table is present.
- `cd /workspaces/ai-dev-control-plane && npm run lint 2>&1`
  - Result: pass. All configured `node --check` targets completed successfully.
- `cd /workspaces/ai-dev-control-plane && npm test 2>&1`
  - Result: pass. Jest reported 9 test suites passed, 108 tests passed.

## Acceptance Criteria
- [x] `### 移行状況` section updated with per-app authentication table
- [x] `docs/auth/migration-plan.md` link preserved
- [x] Lint: pass
- [x] Unit Test: pass

## Risks
No blocking risks found. Test output includes an existing development warning that `LINEAR_WEBHOOK_SECRET` is not set, but the suite still passed.

## Next Action
READY_FOR_REVIEW
