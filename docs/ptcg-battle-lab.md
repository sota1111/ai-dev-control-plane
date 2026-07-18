# ptcg-battle-lab — resumable 松竹梅 round-robin artifact pipeline (SOT-1713)

A single, canonical entrypoint that runs the 松 (matsu) / 竹 (take) / 梅 (ume) cross-agent
**seat-swap round-robin** and records a **redacted, resumable, checksum-referenced** artifact set.
It replaces the ad-hoc `/tmp` driver scripts previously used for these battles (SOT-1681/1701/1702),
whose outputs lived outside git, could not be resumed without double-counting, and sometimes leaked
host paths.

## One command

```bash
# fresh run (or resume — same command, same --run-id)
tsx src/ptcg-battle-lab-cli.ts run --run-id 20260718 --matches 40 --seed 20260718

# inspect
tsx src/ptcg-battle-lab-cli.ts status --run-id 20260718

# check contestant repos + resolve their commit / deck hash
tsx src/ptcg-battle-lab-cli.ts preflight
```

Re-invoking `run` with the **same `--run-id`** resumes: already-completed shards are skipped, never
re-run, and never re-aggregated.

## What a run produces

- `artifacts/ptcg-battle-lab/runs/manifest.<run-id>.json` — the **git-managed artifact**. Holds the
  run-id, schema version, run conditions (matches/seed/deck-mode), per-contestant **inputs** (repo
  name, commit SHA, deck **hash**), and one entry per shard with its status, tally, and a **reference**
  (object key + sha256 checksum + byte size) to the raw log. It contains **no** raw game bytes, no
  tokens, no absolute/host paths — `saveManifest` asserts this before every write.
- `artifacts/ptcg-battle-lab/objects/<run-id>/<shard>.games.jsonl` — the **raw per-match logs**, in the
  object store (git-ignored; stands in for S3/GCS behind the `ObjectStore` interface).

## Shards — the 先後入替 round-robin

Every unordered pair of contestants is played in **both seat orientations** (先手/後手 swap), giving
6 shards for the 3 contestants (`matsu-vs-take`, `take-vs-matsu`, …). `--chunks N` splits each
orientation into `N` seed-chunks for parallelism. Shard ids are **stable** across resume, so a re-run
maps 1:1 onto the same plan.

## Resume / atomicity / duplicate rejection

- Each shard's manifest update is written **atomically** (temp file + `rename`), so an interruption at
  any point leaves a valid, parseable manifest.
- `recordShardResult` **rejects** re-recording a completed shard; the aggregate sums each completed
  shard's tally exactly once, so resume can never double-count.

## Runners (`--runner`)

- `fixture` (default): a deterministic seeded stand-in so the pipeline is fully runnable/verifiable in
  the control-plane and CI **without** the cabt engine.
- `python`: shells to `ptcg-agent-matsu/eval/battle_matsu_take_ume.py` (needs the engine + sibling
  checkouts). Real match play stays the driver's responsibility; this pipeline owns orchestration,
  resume, and artifacts.

## Redaction (no secrets / host info)

`findArtifactLeaks` scans every artifact for host-specific absolute paths (`/workspaces/`, `/home/`,
…), token-like strings (`ghp_…`, `sk-…`, bearer/PEM, …), and values equal to a sensitive environment
variable. `saveManifest` refuses to persist anything that trips it.

## Code

- `src/lib/ptcgBattleLab.ts` — pure/deterministic orchestration, object store, manifest lifecycle,
  aggregation, redaction, schema validation.
- `src/ptcg-battle-lab-cli.ts` — the single CLI entrypoint.
- `src/__tests__/ptcgBattleLab.test.ts` — fixture preflight → battle → artifact integration plus the
  interruption / resume / duplicate-rejection / atomicity / schema-validation / redaction tests.
