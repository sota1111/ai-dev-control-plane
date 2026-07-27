# Final Report — SOT-2001

## Summary

Packaged the registered `observation-rule-v1` ARC-AGI-3 champion as a
dependency-free JSONL exec entrypoint and an official Kaggle framework kernel.
The kernel reached `COMPLETE`; the authenticated submission attempt was refused
before reference creation because Kaggle reported `0 submissions remaining
today`, and that external-cap skip is recorded without attributing another
lineage's score to this champion.

## Changed Files

- `scripts/ai/arc_agi3_champion_exec.py` — deterministic stdin/stdout contract.
- `src/__tests__/arcAgi3ChampionExec.test.ts` — subprocess, schema,
  determinism, invalid-input, and fingerprint tests.
- `kaggle/arc-agi-3-gpt-champion/` — official framework adapter and kernel.
- `scripts/ai/kaggle_targets_registry.json` — exact competition, kernel,
  candidate, and evaluation fingerprint wiring.
- `docs/ai/kaggle/SOT-2001-champion-submission.md` — gate and submission
  evidence.

## Verification

- `npm run lint` — pass.
- `npm run typecheck` — pass.
- `npm test -- --runInBand` — 96 suites / 1165 tests pass.
- Python entrypoint and kernel sources compile — pass.
- `git diff --check` — pass.
- E2E — N/A; this repository defines no `e2e` script.
- Kernel `sota1111/arc-agi-3-gpt-registered-champion`, version 3 — `COMPLETE`.

## Acceptance Criteria

- [x] Exec manifest exactly matches the current champion registry and confirmed
  evaluation fingerprint.
- [x] Champion passes subprocess exec, output schema, determinism, malformed
  input, and production replay equivalence tests.
- [x] Kaggle submission was attempted with a complete artifact; the exact daily
  quota skip is preserved with no fabricated ref/status/score.
- [x] Existing screen→confirm promotion evidence is resolved and no new rejected
  candidate exists to revert.

## Risks

Version 3 still needs a submission after the shared ARC-AGI-3 daily quota
resets. Until then it has no submission-specific score.

## Acceptance: PASS
## Next Action: READY_FOR_REVIEW
