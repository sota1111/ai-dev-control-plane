# Final Report — SOT-2180

## Summary

The two SOT-2179 candidates were implemented as conservative, training-fitted
evaluation candidates and run through the fixed small screen. Both safely
fell back to identity on all five screen tasks, with zero faults and zero
negative activation, but neither solved its positive task. Per the registered
gate, confirm was not run and neither candidate was promoted.

## Changed Files

- `scripts/ai/evaluate_arc_mixed_dimension.py`
- `src/__tests__/arcMixedDimensionEvaluation.test.ts`
- `docs/ai/kaggle/SOT-2180-mixed-dimension-evaluation.json`
- `docs/ai/kaggle/SOT-2180-mixed-dimension-decision.md`
- SOT-2179 specification and verifier, carried into the feature branch as the
  required implementation contract.

## Verification

- Pinned fixture/spec verification: PASS.
- Fixed screen replay: PASS as a protocol run; promotion decision `reject`.
- Candidate faults: 0; negative activations: 0.
- Independent confirm: correctly `not_run` because screen failed.
- Registry/champion consistency: PASS (`identity`, unchanged).
- Production solver/runtime diff: none.
- `npm run lint`: PASS.
- `npm run typecheck`: PASS.
- `npm test`: PASS (101 suites / 1,203 tests).
- E2E: N/A (no `e2e` script; no UI/runtime behavior changed).
- Diff review: PASS; changes are limited to the inherited specification,
  evaluation helper/test, decision evidence/docs, and this report.

The first complete test invocation found the isolated worktree had no local
`node_modules/.bin/tsx`; linking the repository's existing dependency
directory into the worktree resolved the environment-only failure. The full
suite then passed without a product-code fix.

## Acceptance

- [x] Both fixed candidates have minimal, training-only implementations and
  deterministic fixture replay.
- [x] Screen result and incumbent comparison are saved; confirm early-stop is
  explicit and follows the pre-registered order.
- [x] The non-promotion conclusion matches the unchanged `identity` champion.
- [x] No production solver behavior was introduced.
- [x] Exec compatibility/submission schema is N/A under the promotion-only
  contract.

## Acceptance: PASS

## Next Action: READY_FOR_REVIEW
