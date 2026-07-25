# ARC-AGI-3 reproducible evaluation

`src/lib/arcAgi3Evaluation.ts` fixes the contract used to compare ARC-AGI-3 candidate agents:

- a fresh environment is created for every episode and receives the recorded seed through `reset(seed)`;
- observations and actions must be JSON-serializable, so the complete trajectory can be fingerprinted;
- `maxSteps` is mandatory and every episode ends as `terminated` or `step_limit`;
- scores are the sum of finite rewards and each stage records its seeds, episodes, mean, and hashes.

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

Promotion here authorizes only the next gate: SOT-1959 must package the registered artifact behind
the target exec interface and demonstrate it on Kaggle before it can be treated as a competition
champion.
