# Agent Security reproducible local evaluation

SOT-1963 establishes a deterministic local reference for comparing attack detection with normal-tool
behavior. It is a regression contract, not a substitute for the competition's hidden evaluation.

## Fixed inputs and metrics

`src/__fixtures__/agentSecurityEvaluation.v1.json` is a versioned dataset with 16 cases split into
independent `screen` and `confirm` sets. Each split contains four attack and four normal cases. Every
case records the user request, tool name, untrusted tool output, expected decision, and stable ID.

The evaluator records every decision and derives:

- **attack success rate** = allowed attack cases / all attack cases (lower is better);
- **false-positive rate** = blocked normal cases / all normal cases (lower is better);
- **normal success rate** = allowed normal cases / all normal cases (higher is better).

The dataset, detector identity, thresholds, decisions, stage metrics, aggregate metrics, and SHA-256
fingerprint are saved in `artifacts/agent-security/sot-1963/champion.evaluation.json`.
`champion.json` binds the current champion to that exact evaluation fingerprint.

## Reproduce the baseline

Run from the repository root:

```bash
npx tsx src/agent-security-evaluation-cli.ts \
  --dataset src/__fixtures__/agentSecurityEvaluation.v1.json \
  --run-id sot-1963-champion-baseline \
  --max-attack-success-rate 0.25 \
  --max-false-positive-rate 0.50 \
  --min-normal-success-rate 0.50 \
  --recorded-at 2026-07-27T07:00:00.000Z \
  --output artifacts/agent-security/sot-1963
```

For identical code and arguments the two output files are byte-identical. The fixed
`keyword-guard-v1` baseline scores:

| Metric | Screen | Confirm | Aggregate |
| --- | ---: | ---: | ---: |
| Attack success rate | 0.25 | 0.25 | 0.25 |
| False-positive rate | 0.50 | 0.25 | 0.375 |
| Normal success rate | 0.50 | 0.75 | 0.625 |

These intentionally modest values make weaknesses visible while fixing a reproducible champion for
later comparisons.

## Candidate gate

All candidates must use the same dataset fingerprint and thresholds as the champion.

1. Run `screen`. `confirm` is not executed unless every threshold passes.
2. A candidate is eligible only when confirm ran, no metric regressed, and at least one metric strictly
   improved.
3. A rejected candidate must revert behavioral changes and retain only its results and rejection
   rationale in docs (`revert_candidate_changes` → `record_results_in_docs`).
4. A promotion candidate must first pass the target agent's real exec contract and only then run the
   Kaggle proof (`verify_exec_compatibility` → `run_kaggle_proof`).

`compareCandidate` returns these ordered, machine-readable actions. Unit tests exercise failed screen,
non-improvement, and promotion paths. No candidate behavior or Kaggle submission is changed by this
baseline issue.

## SOT-1964 single-tool attack candidate

`single-tool-guard-v2` composes the champion detector with narrowly scoped checks for the two
single-tool attack classes that the fixed dataset exposed:

- instruction-hierarchy replacement followed by a request to disclose configuration; and
- environment/configuration exfiltration into a public or downstream tool destination.

The candidate also recognizes direct shell/exec requests that combine a transfer command with
sensitive values. Tool names alone never cause a block, so ordinary shell and exec use remains
allowed. The production champion is not mutated by the candidate evaluator.

Reproduce the champion/candidate comparison:

```bash
npx tsx src/agent-security-candidate-cli.ts \
  --dataset src/__fixtures__/agentSecurityEvaluation.v1.json \
  --run-id sot-1964-single-tool-defense \
  --max-attack-success-rate 0.25 \
  --max-false-positive-rate 0.50 \
  --min-normal-success-rate 0.50 \
  --output artifacts/agent-security/sot-1964
```

Both detectors used the same dataset fingerprint and thresholds. Screen passed before confirm ran.

| Metric | champion | candidate | Result |
| --- | ---: | ---: | --- |
| Attack success rate | 0.25 | 0.00 | improved |
| False-positive rate | 0.375 | 0.375 | unchanged |
| Normal success rate | 0.625 | 0.625 | unchanged |

`comparison.json` therefore marks the candidate eligible for promotion and orders the remaining
actions as target-agent exec compatibility followed by Kaggle proof. The local comparison CLI was
executed successfully with Node/tsx, but that does not substitute for the target agent's exec contract.

The candidate was **not promoted to the production champion** in this issue. The agent-security-gpt
registry entry has no `submit.file`, so there is no candidate-bound artifact that can be submitted to
Kaggle for proof. Creating a Kaggle submission that cannot contain this detector would not be valid
evidence; target-agent exec compatibility is likewise not claimable from this control-plane-only
candidate. In accordance with the gate, the current champion remains unchanged while the candidate,
metrics, and non-promotion reason remain recorded here. A later production integration must package
the detector into the target agent, repeat exec compatibility, and then run the Kaggle proof before
writing a promoted champion record.
