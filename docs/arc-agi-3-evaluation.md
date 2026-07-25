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
