# Final Report — SOT-1965

## Summary

Added `multi-step-state-guard-v1`, a session-local risk-state detector that preserves the existing
single-tool defense and blocks a later external transition after sensitive context has been staged for
deferred use. Added reproducible screen/confirm scenarios, comparison evidence, regression tests, and
the promotion decision.

## Changed Files

- `src/lib/agentSecurityMultiStepDefense.ts` — stateful detector and multi-step evaluator.
- `src/__fixtures__/agentSecurityMultiStep.v1.json` — four attack and four normal sequences.
- `src/agent-security-multi-step-cli.ts` — reproducible champion/candidate comparison CLI.
- `src/__tests__/agentSecurityEvaluation.test.ts` — state transitions and regression coverage.
- `artifacts/agent-security/sot-1965/` — screen/confirm comparison evidence.
- `docs/agent-security-evaluation.md` — metrics, reproduction command, and non-promotion rationale.

## Verification

- `npm run lint` — pass.
- `npm run typecheck` — pass.
- `npm test -- --runInBand` — 97 suites / 1,177 tests pass.
- `npm run lint:eslint -- --quiet` — pass.
- Prettier check and `git diff --check` — pass.
- E2E — N/A; this repository defines no `e2e` script and no UI changed.

## Acceptance Criteria

- [x] Multi-step attack success rate was compared with the champion: `1.00 → 0.00`.
- [x] Normal multi-step success stayed `1.00`; existing single-step attack/normal metrics stayed
      `0.00` / `0.625`.
- [x] Screen passed before confirm executed, and both stages are recorded independently.
- [x] The local candidate strictly dominated the champion, but production promotion was withheld
      because target exec packaging and a candidate-bound Kaggle artifact are unavailable.

## Risks

The detector remains a control-plane candidate. The `agent-security-gpt` registry has an empty
`submit.file`, so production promotion still requires packaging into the target agent, exec
compatibility verification, and then Kaggle proof in that order.

## Acceptance: PASS
## Next Action: READY_FOR_REVIEW
