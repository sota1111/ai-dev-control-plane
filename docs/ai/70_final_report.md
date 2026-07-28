# Final Report — SOT-2086

## Summary

- Confirmed SOT-2085 was a non-promotion and kept
  `observation-rule-v1` as the registered ARC-AGI-3 GPT champion.
- Made the Kaggle kernel source self-contained and published version 4.
- Pinned exec, package source, pulled artifact, candidate, and evaluation
  fingerprints in the target registry.
- Verified the dependency-free exec contract, output schema, determinism,
  invalid-input termination, and zero valid-fixture faults.
- Attempted the current champion submission. Kaggle allocated no ref because
  the one-per-UTC-day ARC-AGI-3 quota had already been consumed; the exact
  attempt and existing ref/status/score are recorded.

## Changed Files

- `kaggle/arc-agi-3-gpt-champion/submit.py`
- `scripts/ai/kaggle_targets_registry.json`
- `src/__tests__/arcAgi3ChampionExec.test.ts`
- `docs/ai/kaggle/SOT-2086-champion-submission.md`
- `docs/ai/70_final_report.md`

## Verification

- Focused ARC-AGI-3 exec tests: 4/4 passed
- Lint: passed
- Typecheck: passed
- Unit tests: 99/99 suites, 1,194/1,194 tests passed
- E2E: N/A (no E2E script and no UI change)
- Kaggle kernel version 4: `COMPLETE`
- Committed/pulled Kaggle source byte comparison: passed
- Submission: concrete daily-quota skip; no ref allocated

## Acceptance Criteria

- [x] SOT-2085 non-promotion, candidate revert, and unchanged champion registry agree.
- [x] Submission target candidate/evaluation and exec/source/artifact fingerprints agree.
- [x] Current champion passes exec, schema, determinism, termination, and fault gates.
- [x] Kaggle attempt evidence records the exact quota skip and the current external status.
- [x] The complete screen→confirm→non-promotion/revert→incumbent exec→Kaggle-attempt gate is documented.

## Risks

- Version 4 has not received a new competition submission ref because the
  shared daily slot was already used. It is published and `COMPLETE`, ready for
  the next eligible GPT slot.

## Acceptance: PASS
## Next Action: READY_FOR_REVIEW
