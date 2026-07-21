# PTCG dataset / replay / training artifact lineage

`src/lib/ptcgArtifactLineage.ts` defines the versioned `ptcg-artifact-lineage/v1` manifest for the
self-play training pipeline. Every replay is identified by the SHA-256 of its canonical payload; shards,
datasets, and models are identified by the canonical ordered references and training configuration that
created them. Repeated replay or shard inputs are normalized and counted once.

The graph is `model → dataset → shard → replay → match/run`. Use `traceModel(manifest, modelId)` to
produce the complete reverse lookup, including source match IDs. Manifests contain portable identities
and lineage metadata only; payload/object retention remains the responsibility of the artifact store.

## Builder workflow

1. Add each completed self-play payload with `addReplay({ runId, matchId, payload })`.
2. Group replay IDs with `addShard`; duplicate IDs are removed and ordering is canonical.
3. Build the dataset with `addDataset`; a replay present through repeated shards is counted once.
4. Register the training input with `addModel(datasetId, trainingConfig)`.
5. Persist `builder.manifest()` with `saveLineage`. The write uses `.partial` plus atomic rename.

The same inputs create byte-equivalent manifests regardless of insertion order. Never substitute a
mutable filename or timestamp for a content ID.

## Resume and recovery runbook

Before resuming training, call `loadLineage`. It validates the schema, identity shape, uniqueness, and
every model/dataset/shard/replay reference. A leftover `.partial` file or a corrupt/missing reference is
an explicit failure; training must not continue from it.

For an interrupted manifest write, call `recoverLineage(file, rebuild)`. It removes only the staging
`.partial` file, invokes the deterministic builder callback from checksum-verified source objects, writes
atomically, and validates the result again. If the final manifest itself is corrupt, preserve it for
incident analysis and rebuild to a new path from the replay object store; do not edit hashes manually.

Retention order follows the dependency graph: retain model and dataset manifests for the model lifetime,
retain replay objects while any retained dataset references them, and delete unreferenced partial files
only after a successful rebuild. A retention job must use reverse references before deleting shards or
replays.
