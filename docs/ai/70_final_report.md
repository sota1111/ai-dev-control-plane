# SOT-2126 Final Report

## Summary

Confirmed that SOT-2125's non-promotion decision is reflected end-to-end. The
target repository still selects `identity`, and its source is byte-identical to
the committed and published Kaggle kernel. The existing kernel version 4 is
COMPLETE and its real output passes the ARC submission schema.

The current champion was already submitted successfully today. The execute-mode
planner preserved the alternate order and daily cap by recording an idempotent
skip instead of allocating a duplicate submission.

## Changed Files

- `docs/ai/kaggle/SOT-2126-champion-submission.md` — champion fingerprint,
  kernel/output status, submission ref/score, and skip evidence
- `docs/ai/70_final_report.md` — lifecycle result and quality-gate summary

## Acceptance Criteria

- [x] SOT-2125 concluded non-promotion, while the target registry,
  control-plane registry, committed runtime, and published runtime consistently
  identify the `identity` champion at SHA-256
  `94dc28395abe6c5046d1bf9af8376913e5a83aaa8fe11164656f54195f1f1a8b`.
- [x] The runtime executes from an unrelated cwd without `__file__` or network
  dependencies; the downloaded real artifact contains all 240 task IDs and 259
  test cases with exactly two attempts per case.
- [x] The non-promoted incumbent, not either rejected pattern candidate, is the
  packaged COMPLETE kernel.
- [x] Alternate order, daily cap 1, and idempotency were honored: ref `55050349`
  already consumed today's slot, so the execute plan created no duplicate.
- [x] Submission ref `55050349`, COMPLETE status, public score `0.00`, kernel
  version 4, and the explicit skip reason are saved.

## Verification

- Published kernel status and source pull: PASS
- Target/committed/published fingerprint comparison: PASS
- Downloaded 240-task / 259-test output schema replay: PASS
- Focused champion and planner tests: PASS (2 suites / 36 tests)
- `npm run lint`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS (99 suites / 1,196 tests)
- E2E: N/A (no `e2e` script and no UI behavior)
- Diff review: PASS; evidence-only change, no solver/runtime/registry drift

## Risks

The current identity champion scores `0.00`; this issue confirms publication
integrity rather than solver quality. A future solver candidate requires a new
pre-specified screen/confirm cycle before changing the champion.

## Acceptance: PASS
## Next Action: READY_FOR_REVIEW
