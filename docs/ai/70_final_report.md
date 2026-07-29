# SOT-2179 Final Report

## Summary

Classified all nine pinned ARC-AGI-2 evaluation fixtures in the
`mixed-dimension-structural-transform` remainder bucket into four reproducible
families. Fixed two minimal, task-disjoint screen/confirm candidates:
separator-guided panel reflow and marker-guided rigid object assembly.

The specification explicitly rejects ordered object linearization and symbolic
stencil expansion to avoid repeating the prior object-selection and
pattern-completion axes. This PLAN issue changes no solver, registry, or
champion behavior.

## Changed Files

- `docs/ai/kaggle/SOT-2179-mixed-dimension-structural-spec.json` — pinned
  fixture hashes, per-task classification/evidence, candidate guards, disjoint
  cohorts, thresholds, and next-stage contract
- `docs/ai/kaggle/SOT-2179-mixed-dimension-structural-spec.md` — human-readable
  candidate rationale, non-overlap argument, gate, and reproduction steps
- `scripts/ai/verify_arc_mixed_dimension_spec.py` — deterministic fixture,
  membership, dimension, cohort, candidate, and threshold checks
- `docs/ai/70_final_report.md` — lifecycle result and acceptance record

## Acceptance Criteria

- [x] The nine mixed-dimension fixtures are pinned by task ID and SHA-256 and
  classified into four reproducible subcategories with counts `2/3/2/2`.
- [x] Two minimal candidates are fixed with exact activation guards and
  rejection conditions. Their non-overlap with contextual recolour, object
  selection/extraction, pattern completion, and the existing DSL is explicit.
- [x] Screen (`5` tasks) and confirm (`4` tasks) are task-disjoint; each contains
  one positive for each candidate plus hard negatives. Both require zero
  faults, exact train consistency on activation, an exact positive win over
  identity, and zero negative activation; confirm also requires zero prior
  portfolio regression.
- [x] The next-stage contract requires reverting failed behavior and retaining
  docs only, or proving stdin-`exec` compatibility and Kaggle evidence before
  any registry/champion promotion.

## Verification

- Pinned specification verifier: PASS — 9 tasks, 4 subcategories, 5 screen,
  4 confirm, 2 candidates
- JSON parse and `git diff --check`: PASS
- `npm run lint`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS — 100 suites / 1,202 tests
- E2E: N/A — repository has no `e2e` script and the change has no UI behavior
- Diff review: PASS — specification/verifier/final report only; no runtime,
  solver, registry, or champion files changed

The first full test invocation exposed a worktree-local dependency-path issue
in `ptcgProfile.test.ts`; after linking the repository's existing
`node_modules` into the isolated worktree, the focused suite and the complete
test gate both passed. No product source change was required.

## Risks

The candidates are specifications, not implemented solvers. SOT-2180 must
enforce every activation guard and must not infer promotion from train fit
alone. `21897d95` remains a deliberate hard negative for the rigid assembly
candidate because it performs region rendering/recolouring.

## Acceptance: PASS
## Next Action: READY_FOR_REVIEW
