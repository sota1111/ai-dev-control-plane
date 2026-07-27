# Final Report — SOT-2012

## Summary

SOT-2009 did not promote its candidate, so the `identity` incumbent was packaged
into the dedicated ARC-AGI-2 GPT kernel. Target `main.py`, packaged
`submission.py`, and the registry fingerprint all match SHA-256
`94dc28395abe6c5046d1bf9af8376913e5a83aaa8fe11164656f54195f1f1a8b`.

Kernel version 3 reached `COMPLETE`. The last submission was Claude lineage, so
the alternate planner selected GPT. The GPT attempt was rejected before ref
allocation because the competition's one-per-day slot was already consumed by
ref `55016869`; the exact evidence is recorded in
`docs/ai/kaggle/SOT-2012-champion-submission.md`.

## Changed Files

- `kaggle/arc-agi-2-gpt-champion/` — offline kernel source and metadata.
- `scripts/ai/kaggle_targets_registry.json` — champion identity, fingerprint, kernel version.
- `src/__tests__/arcAgi2GptChampionExec.test.ts` — exec, schema, and fingerprint gates.
- `docs/ai/kaggle/SOT-2012-champion-submission.md` — publication/submission evidence.

## Verification

- Lint: pass.
- Typecheck: pass.
- Unit tests: 98 suites / 1,180 tests pass.
- Focused exec/schema/fingerprint tests: pass (3/3).
- Kaggle planner tests: pass (33/33).
- E2E: N/A; this repository defines no e2e script and no UI changed.
- Kernel: version 3, `COMPLETE`.
- Diff review: pass.

## Acceptance Criteria

- [x] GPT dedicated kernel reached `COMPLETE`.
- [x] Champion and packaged artifact fingerprints match.
- [x] Offline exec and submission schema are verified.
- [x] Alternate GPT attempt and concrete daily-cap skip evidence are recorded.

## Risks

The daily cap prevented a new submission ref. Version 3 remains reusable in the
next GPT slot without rebuilding.

## Acceptance: PASS
## Next Action: READY_FOR_REVIEW
