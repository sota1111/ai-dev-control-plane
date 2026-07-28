# Final Report — SOT-2085

## Summary

`stateful-frame-difference-v1` was implemented and evaluated against
`observation-rule-v1` on SOT-2084's fixed, disjoint screen/confirm cohorts. It
passed screen without regression, then improved confirm level progress from 2
to 3 while reducing faults from 1 to 0.

The corpus is explicitly synthetic production-shaped evidence, not authenticated
production evidence. The candidate therefore was not promoted, its behavior code
was reverted, and the champion registry remains unchanged.

## Changed Files

- `artifacts/arc-agi-3/sot-2085/stateful-frame-difference-comparison.json` —
  immutable candidate/corpus fingerprints, incumbent comparison, diagnostics,
  and non-promotion decision.
- `docs/ai/kaggle/SOT-2085-stateful-frame-difference-decision.md` — hypothesis,
  screen→confirm result, and reason for reverting the candidate.
- `docs/ai/70_final_report.md` — final lifecycle report.

## Verification

- Candidate focused tests before revert: 6/6 pass.
- Lint and typecheck before revert: pass.
- Final repository lint and typecheck: pass.
- Final unit suite: 99/99 suites, 1,193/1,193 tests pass in-band.
- E2E: N/A; no e2e script and no UI change.
- Final diff review: pass; only SOT-2085 evidence, decision record, and this report remain.

## Acceptance Criteria

- [x] Deterministic frame-difference/action-history/no-op candidate was implemented and tested.
- [x] Only a screen-passing candidate ran on the disjoint confirm cohort.
- [x] Level progress, no-op rate, faults, termination, and fingerprints are reproducible.
- [x] Non-promotion, candidate revert, and unchanged champion registry agree.
- [x] Exec/Kaggle gates were skipped because authenticated production confirm is unavailable.

## Risks

The favorable confirm result is a hypothesis signal only. A future run needs
authenticated production screen/confirm data before restoring this candidate,
checking exec compatibility, changing the registry, or running Kaggle proof.

## Acceptance: PASS
## Next Action: READY_FOR_REVIEW
