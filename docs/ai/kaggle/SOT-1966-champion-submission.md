# SOT-1966 champion submission evidence

## Decision

The current production champion is still SOT-1963 `keyword-guard-v1`:

- artifact: `sha256:0de2a9ade5aaab842f31a83ed4eccc9daebc4552d504827a122f5490696962a5`
- evaluation: `9d061b1646df2d0734f1c414106b9718af13342695dde0612b6da28e7bc37bd2`

SOT-1964 and SOT-1965 both retained their candidate implementations and measurements but explicitly
did not promote them. No candidate behavior is therefore present in the audited champion.

## Screen

Screen passed:

1. `champion.json` and `champion.evaluation.json` identify the same detector, artifact, and evaluation.
2. The SOT-1964 and SOT-1965 conclusions both leave the production champion unchanged.
3. The `agent-security-gpt` registry entry has no `submit.file`, so the completion runner cannot
   silently submit an unrelated local file.

## Confirm: exec and Kaggle contract

The official competition bundle for `ai-agent-security-multi-step-tool-attacks` was downloaded with
Kaggle CLI 2.2.4 on 2026-07-27. Its rerun entry point is
`kaggle_evaluation.jed_attack_134815.JEDAttackInferenceServer`; it loads only:

- `attack.py`;
- class `AttackAlgorithm`;
- a subclass of `AttackAlgorithmBase` that returns red-team `AttackCandidate` message chains.

The production champion is a defense detector. Its contract consumes `userMessage`, `toolName`, and
`toolOutput`, then returns `block` or `allow`. The Kaggle rerun does not load that contract. Relabeling
the detector as `AttackAlgorithm` would not be an adapter: it would be a different artifact with
different behavior. Confirm therefore failed the compatibility gate.

## Kaggle proof and skip reason

No new submission was created. Exact skip reason:
`champion_contract_incompatible_with_competition_track`.

Kaggle submission ref `55016915` already existed at `2026-07-27 03:00:27 UTC` with description
`auto-improve submit: agent-security-gpt champion`, status `COMPLETE`, and public score `0.000`.
Inspection of `sota1111/agent-security-gpt-cli-baseline` showed a red-team starter
`AttackAlgorithm`, not `keyword-guard-v1`; that submission is therefore not accepted as champion
proof.

This is the concrete “submission artifact not ready” terminal condition allowed by the issue. The
registry remains unmodified and automatic submission remains disabled for this target until either
the Kaggle track accepts a defense artifact or the target's production champion is intentionally
defined and evaluated as a red-team `AttackAlgorithm`.

Machine-readable evidence is in
`artifacts/agent-security/sot-1966/submission-audit.json`.
