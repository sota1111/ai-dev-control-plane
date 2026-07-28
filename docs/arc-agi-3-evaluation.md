# ARC-AGI-3 reproducible evaluation

`src/lib/arcAgi3Evaluation.ts` fixes the contract used to compare ARC-AGI-3 candidate agents:

- a fresh environment is created for every episode and receives the recorded seed through `reset(seed)`;
- observations and actions must be JSON-serializable, so the complete trajectory can be fingerprinted;
- `maxSteps` is mandatory and every episode ends as `terminated` or `step_limit`;
- scores are the sum of finite rewards and each stage records its seeds, episodes, mean, and hashes.

## Production FrameData / GameAction boundary

`src/lib/arcAgi3Gateway.ts` is the production-contract adapter. It validates the gateway's `FrameData`
shape (`game_id`, `guid`, 3D 0–15 colour grid, lifecycle state, level counts, echoed action, and legal
actions, plus optional `full_reset`) and the selected `GameAction`. Actions 1–5 are parameterless; action 6 requires integer
`x`/`y` coordinates in the 0–63 gateway range. An unavailable action is rejected before a step.

`GatewayReplayEnvironment` feeds recorded production-shaped frames into the existing episode runner.
Each replay pins its expected legal action and next frame; level-count changes become the episode
reward, and `WIN`/`GAME_OVER` are terminal. `createGatewayAgent` converts a function from `FrameData`
to `GameAction` into the existing evaluation agent interface. The committed replay fixture at
`src/__fixtures__/arcAgi3GatewayReplay.json` exercises a two-step win and can run both screen and
confirm without network access.

### Replay corpus and action-effect diagnostics (SOT-2084)

`arcAgi3GatewayReplayCorpus.json` fixes four production-shaped episodes across three game contracts.
The two `screen` episode IDs and two `confirm` episode IDs are non-empty and disjoint. The corpus
validator also rejects reuse of the same `game_id` + `guid` across cohorts, duplicate episode IDs,
invalid replays, and provenance that presents synthetic data as production evidence.

Every episode carries provenance. This committed corpus is deliberately marked
`source: "synthetic"` and `productionEvidence: false`: the repository contains neither an
authenticated ARC-AGI-3 production capture nor credentials to obtain one. A concrete `blockReason` is
required for synthetic entries; production entries instead require `capturedAt` and positive evidence.
Thus these fixtures verify the production contract but do not claim production performance.

`diagnoseGatewayReplayCorpus` deterministically emits
`arc-agi-3-replay-diagnostics/v1`. For every transition it records the selected action, whether it was
legal in the preceding frame, changed cell count, level delta, no-op status, and resulting game state.
Episode and corpus aggregates include steps, frame changes, level progress, no-ops, faults, and
`WIN` / `GAME_OVER` / `EXHAUSTED` termination counts. The canonical SHA-256 corpus fingerprint makes
the exact evidence set reproducible.

The checked baseline is
`artifacts/arc-agi-3/sot-2084/production-contract-baseline.json`. It binds the current
`observation-rule-v1` registry and evaluation fingerprints to the corpus fingerprint. No behavior was
promoted: authenticated production confirm remains unavailable, so exec compatibility and Kaggle proof
are intentionally gated. When real captures become available, anonymize identifiers, mark their
provenance as production with capture time, run the short screen cohort first, and only run the
disjoint confirm cohort after screen passes.

## Screen → confirm

The two stages use explicit, non-empty, unique, disjoint seed sets. A candidate runs the larger
independent confirm set only when its screen mean reaches `screenMinimumMean`. The same `candidateId`
and immutable `artifactId` are written once at the evaluation root, preventing a different build from
being substituted between stages.

An adapter module exports `createEnvironment()` and `createAgent()`. Run it without adding a package
script:

```bash
npx tsx src/arc-agi-3-evaluation-cli.ts \
  --module ./eval/adapter.ts \
  --run-id candidate-20260725 \
  --screen-seeds 100,101,102 \
  --confirm-seeds 200,201,202,203,204 \
  --max-steps 200 \
  --screen-minimum-mean 1 \
  --output artifacts/arc-agi-3/candidate-20260725.json
```

## Evidence and champion registry

Evaluation files use `arc-agi-3-evaluation/v1`; the champion registry uses
`arc-agi-3-champion-registry/v1`. `writeEvaluationArtifact` and `writeChampionRegistry` use
write-then-rename, and a promoted champion stores the exact evaluation fingerprint, candidate artifact,
environment version, and promotion timestamp.

Promotion is an operational gate, not an automatic side effect of scoring:

1. Commit the candidate so `artifactId` identifies immutable code, then run screen and confirm.
2. If the candidate is **not promoted**, revert the candidate code. Keep and commit only its evaluation
   JSON plus a Markdown decision that records the fingerprint and rejection reason.
3. If it **is promoted**, update the registry with `promoteChampion`, verify that the candidate package
   satisfies the target repository's exec interface, and only then hand it to the Kaggle proof run.
4. Never update the registry for a screen-only evaluation; `promoteChampion` rejects it.

The deterministic fixture tests cover reproducibility, both termination paths, aggregate scores,
screen-to-confirm identity, disjoint seeds, atomic evidence persistence, and registry linkage.

## Initial baseline champion (SOT-1958)

The first comparison deliberately uses the deterministic contract environment rather than a Kaggle
score. Its purpose is to prove the agent boundary and promotion workflow before SOT-1959 connects the
winner to the competition exec adapter:

- `random-control-v1` is a seeded deterministic control which ignores the observation;
- `observation-rule-v1` selects the task signal only when it is present in `legalActions`;
- the environment rejects illegal actions and terminates after four steps;
- screen seeds `101–106` and confirm seeds `201–210` are disjoint.

The committed evidence is under `artifacts/arc-agi-3/sot-1958/`. With a screen minimum mean of `3`,
the random control scored `0.5` and was rejected before confirm. The observation rule scored `4.0` in
screen and `4.0` on independent confirm seeds. It met the confirm promotion minimum of `3`, so
`champion.json` registers `observation-rule-v1` and binds it to evaluation fingerprint
`339695bade7dba7fd964558e407984d0842168544a0cbf4d8825414b96042218`.

Reproduce the decision from the candidate commit:

```bash
npx tsx src/arc-agi-3-baseline-cli.ts \
  --artifact-id git:01d8177 \
  --promoted-at 2026-07-25T23:45:00.000Z \
  --run-id sot-1958-initial-baselines \
  --screen-seeds 101,102,103,104,105,106 \
  --confirm-seeds 201,202,203,204,205,206,207,208,209,210 \
  --max-steps 4 \
  --screen-minimum-mean 3 \
  --output artifacts/arc-agi-3/sot-1958
```

Promotion here authorizes only the next gate. The SOT-1958 champion used a synthetic signal fixture;
it is not a production champion. In `kaggle_targets_registry.json`, both ARC-AGI-3 lineages therefore
remain `champion_status: "unproven"` under `evaluation_contract: "production-gateway"` until a
production-contract confirm passes.

For every candidate:

1. Run a short production-contract screen. Only a passing candidate proceeds to an independently
   configured confirm replay/run.
2. On non-promotion, revert candidate code while retaining evaluation JSON, hypothesis, and rejection
   reason in docs.
3. On promotion, update the champion registry to the exact confirm fingerprint, verify the packaged
   agent against the competition exec interface, and only then run the Kaggle proof.
