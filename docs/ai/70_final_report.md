# SOT-1850 Final Report

## Summary

- Added Ume's machine-readable high-variance archetype and aggressive risk/search profile.
- Added a deterministic common-league adapter with an eight-hour exploration budget and checkpoint/resume.
- Published a 20-seed, seat-reversed A/B and four-agent cross-play artifact (240 games).

## Verification

- `npm run lint`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS (82 suites, 1056 tests)
- E2E: N/A (no `e2e` script; deterministic CLI evaluation covers this non-UI change)
- Formatting and `git diff --check`: PASS

## Acceptance Criteria

- [x] Candidate vs baseline: 38-2; Wilson 95% lower bound 0.835 (> 0.50).
- [x] Ume-specific deck and policy profile is recorded in `config/ptcg_ume_aggressive.json`.
- [x] Sol, Debate, Fable, and Zero cross-play completed with 20 fixed seeds and seat reversal.
- [x] Faults, unfinished games, and illegal actions: 0 / 0 / 0.

## Acceptance: PASS
## Next Action: READY_FOR_REVIEW
