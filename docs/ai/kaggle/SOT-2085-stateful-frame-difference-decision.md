# SOT-2085 stateful frame-difference candidate decision

## Hypothesis

A deterministic agent that compares consecutive `FrameData`, remembers action effects, avoids
immediately repeating a no-op, prefers untried legal actions/coordinates, and reuses effective actions
should progress farther than `observation-rule-v1` on production-contract replay.

The evaluated source is immutable at candidate commit `1797998b238ffcd3604996a9aa7b0298ce23ed83`
with source fingerprint
`7e993789adabc01b02db48ef367f72b12bf70d4aa7d4b9999de18e4b321bccd7`.

## Screen → confirm result

The exact SOT-2084 corpus fingerprint is
`54f757be526c8c61d51c3afd2de62d22c5724acd8bcac87a123f26c558bc6bc1`.
The two screen episodes and two confirm episodes are disjoint.

| Cohort | Agent | Level progress | No-op rate | Faults | Replay mismatches |
| --- | --- | ---: | ---: | ---: | ---: |
| screen | incumbent | 1 | 1/3 | 0 | 1 |
| screen | candidate | 1 | 1/3 | 0 | 0 |
| confirm | incumbent | 2 | 0/2 | 1 | 1 |
| confirm | candidate | 3 | 0/3 | 0 | 0 |

The candidate met the predeclared screen rule (no level/no-op regression, zero faults, fewer action
mismatches), so only then was it evaluated on confirm. On confirm it used the effective coordinate
action and legal fallback `ACTION5`, reaching level progress 3 instead of 2 with zero faults.

The complete machine-readable evidence is
`artifacts/arc-agi-3/sot-2085/stateful-frame-difference-comparison.json`.

## Non-promotion decision

The result is **not promoted**. Every replay in the fixed corpus is explicitly synthetic
production-shaped data (`productionEvidence: false`), not an authenticated production capture.
Therefore it cannot satisfy the production-confirm gate regardless of the favorable synthetic result.

Candidate behavior was reverted by commit `17ffe57deaff5a6081c30dace5ad72852a26e088`.
The incumbent registry fingerprints remain unchanged. Exec compatibility and Kaggle proof were not run
because those gates are permitted only after authenticated production confirm.

## Verification performed before revert

- Determinism and immediate no-op avoidance
- Episode/full-reset state reset
- Legal actions and deterministic coordinate bounds `0..63`
- Step limit and legal fallback
- Screen-before-confirm and cohort separation
- Candidate fault count `0`
- Focused tests: 6/6 passed
- Typecheck and lint: passed

After the required revert, the repository-wide gates are run again against the final docs/evidence-only
diff.
