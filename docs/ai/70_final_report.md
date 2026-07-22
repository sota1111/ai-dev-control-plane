# SOT-1867 Final Report

## Summary

The common seven-agent league now launches each pinned repository's real `main.py` in an isolated
process and drives all 21 unordered matchups through the cabt engine with a fixed agent seed and both
seat orientations. Match-level checkpointing makes the run resumable without duplication, and the
generated audit quantifies the real-runtime delta from the existing synthetic/profile league.

## Acceptance evidence

- Reproducible artifact: `artifacts/ptcg-league/sot-1867-runtime/` contains the pinned seven-repository
  manifest, checkpoint, league report, and machine/human-readable runtime audit.
- Fixed seed / seat reversal: seed `186700`; 21 matchups × 2 orientations = 42 recorded matches.
- Checkpoint/resume: two resume executions retained identical checkpoint and audit SHA-256 hashes.
- Safety: fault 0, unfinished 0, illegal action 0, timeout 0.
- Budget: measured real-process runtime 568.310 seconds, below the 8-hour limit.
- Synthetic/profile delta: largest absolute gap is 0.650 in `matsu vs sol` (tied with `sol vs ume`).

## Verification

- `npm run lint` — PASS
- `npm run typecheck` — PASS
- `npm test` — PASS (84 suites, 1,061 tests)
- E2E — repository has no `npm run e2e`; the real cabt 42-match execution is the applicable E2E check.
- `git diff --check` — PASS

## Acceptance: PASS
## Next Action: READY_FOR_REVIEW
