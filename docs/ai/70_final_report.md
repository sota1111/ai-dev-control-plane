# Final Report — SOT-2005

## Summary

Reproduced the ARC-AGI-2 Claude champion's Kaggle 0.00 result and separated
submission-contract behavior from solver capability. The deployed source is
byte-identical to the repository champion, the completed kernel emitted a valid
240-task submission, and the pinned public evaluation cohort reproduces 0/120
exact tasks because the current DSL is train-consistent on 0/120 tasks and
falls back to duplicate identity attempts for all 167 test cases.

## Changed Files

- `scripts/ai/analyze_arc_claude_champion.py` — deterministic solver coverage,
  exact-score, failure-class, and submission-contract analyzer.
- `docs/ai/kaggle/SOT-2005-arc-claude-defeat-analysis.json` — machine-readable
  metrics and per-task evidence.
- `docs/ai/kaggle/SOT-2005-arc-claude-defeat-analysis.md` — reproducible
  baseline, contract/capability conclusion, and evidence-backed improvement
  order.

## Verification

- Control plane: `npm run lint` — pass.
- Control plane: `npm run typecheck` — pass.
- Control plane: `npm test` — 95 suites / 1162 tests pass.
- Analyzer: `python3 -m py_compile ...` — pass.
- Analyzer reproducibility: regenerated JSON equals the committed artifact.
- Claude solver: lint, typecheck, 11 unit tests, and e2e all pass.
- Kaggle: submission `55009090` complete at public score 0.00; kernel complete;
  downloaded output validates against the official 240-task sample contract.
- E2E for the control plane is not defined in `package.json`; the directly
  relevant Claude solver e2e passed.

## Acceptance Criteria

- [x] Failure classes and baseline recorded: 0/120 exact, 0/120 train-supported,
  120/120 fallback; per-transform and per-task metrics are in JSON.
- [x] Improvement candidates selected with evidence: context-dependent
  recolouring/content transformation first (81/120), component
  selection/extraction second (27/120), then distinct train-scored attempt
  diversity.
- [x] Submission contract separated from solver performance: source, kernel,
  input/output task counts, schema, attempts, grids, and serialization pass;
  missing transformation coverage is the supported cause.

## Risks

The public evaluation cohort is a proxy for diagnosing the hidden Kaggle test
score; hidden task solutions are unavailable. Failure-class labels are
deterministic prioritisation categories, not official ARC semantic labels.

## Acceptance: PASS
## Next Action: READY_FOR_REVIEW
