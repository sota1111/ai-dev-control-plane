# PTCG training telemetry and artifact replay

`src/lib/ptcgTrainingTelemetry.ts` defines the versioned boundary for learning telemetry. A producer
passes `TelemetryRunMetadata` plus raw `policy`, `value`, `reward`, and optional `loss` points to
`writeTelemetryArtifact`. Every run records its seed, command, conditions, code revision, schema
version, generator version, raw byte count, and SHA-256 checksum.

```ts
writeTelemetryArtifact('artifacts/ptcg-training', metadata, points);
replayTelemetry('artifacts/ptcg-training', metadata.runId);
```

The run directory contains:

- `manifest.json` — version and reproducibility metadata plus the immutable raw-data reference.
- `metrics.jsonl` — raw scalar observations; this is the replay source of truth.
- `aggregate.json` — deterministic per-tag learning curves and min/max/mean/last summaries.
- `tensorboard/events.out.tfevents.<run-id>` — native TFRecord/protobuf scalar events. Open the run's
  `tensorboard` directory with `tensorboard --logdir <run-dir>/tensorboard`.

`replayTelemetry` verifies the declared size and checksum before parsing raw points, rejects an unknown
schema version explicitly, and then regenerates both derived artifacts. Replaying unchanged raw bytes
with the same checked-in generator produces byte-identical output, so aggregation and visualization do
not depend on the original training process.

Schema compatibility is explicit in `SUPPORTED_TELEMETRY_SCHEMAS`. Breaking raw-shape changes require a
new schema id and a version-specific reader; never silently reinterpret an unsupported artifact.
