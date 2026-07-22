# Final Report — SOT-1847

## Summary

Published a manifest-pinned seven-agent deterministic common league covering all 21 pairings with 20
fixed seeds and both seat orientations (840 games). The checkpoint, JSON/Markdown matrix, fault audit,
and quantitative weakest-matchup analysis are committed under `artifacts/ptcg-league/sot-1847/`.

## Verification

- Planned/recorded: 840/840; 21/21 matchups; 40 games per matchup.
- Missing/duplicate/unknown: 0/0/0.
- Fault/unfinished/timeout: 0/0/0, separated from W-L.
- Checkpoint and report SHA-256 stayed identical after resume.
- `npm run lint`: pass.
- `npm run typecheck`: pass.
- `npm test -- --runInBand`: 79 suites, 1047 tests passed.
- E2E: N/A (no e2e script or browser surface).
- Merge-tree conflict check against `origin/main`: pass.

## Acceptance: PASS
## Next Action: READY_FOR_REVIEW
