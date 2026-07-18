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

## Analysis & reporting (`analyze`, SOT-1711)

## Staged 75-contestant battle (`total-battle`)

Running all 75 tactic×deck contestants at the final sample size is expensive. `total-battle` uses the
same resumable, atomic shard pipeline in two phases: a cheap all-contestant **screen**, then a larger
**confirm** run containing only the screen's top K by win rate.

```bash
tsx src/ptcg-battle-lab-cli.ts total-battle \
  --run-id 20260718-total --screen-matches 8 --keep-top 10 --confirm-matches 40 --chunks 4
```

- Screen schedules every ordered pairing for all 75 contestants at `--screen-matches` per shard.
- Confirm schedules only the selected `--keep-top` contestants at `--confirm-matches` per shard.
- `--chunks` deterministically splits both phases by seed. `--runner fixture` (default) runs entirely
  in the control-plane/CI; use `--runner python` only when the real engine and sibling repos exist.
- Re-run the identical command and `--run-id` after interruption. Phase manifests plus
  `total-battle.<run-id>.json` persist selection; completed shards are skipped and duplicate recording
  remains rejected. Changing `--keep-top` for an existing run is rejected to preserve scoping.
- On completion the CLI analyzes the confirm raw records and prints `best-combo`, whether it is
  statistically **確定/未確定**, and the Wilson-CI/sample-size evidence plus report path. The screen is
  a resource-saving filter, so the final claim is explicitly scoped to its selected top K.

`run`/`status` orchestrate and tally; **`analyze` recomputes the statistics from the RAW game records**
(the `games.jsonl` objects, read back and **checksum-verified** against the manifest ref — the manifest
tally is never trusted) and writes two artifacts:

```bash
# recompute stats from raw records → aggregate + report
tsx src/ptcg-battle-lab-cli.ts analyze --run-id 20260718

# diff against a previous run, tighten the sample floor, and notify Discord
tsx src/ptcg-battle-lab-cli.ts analyze --run-id 20260718 --baseline 20260701 --min-sample 50 --notify
```

- `artifacts/ptcg-battle-lab/runs/aggregate.<run-id>.json` — the machine-readable `Analysis`
  (`ptcg-analyze/v1`): per-agent / per-**先後(seat)** / per-**pair** / per-**deck** breakdowns, each with
  Wilson 95% CI, W-L, decided/draws/faults, and **average turns & time**; the ranking verdict; optional
  diff vs a baseline; and warnings.
- `artifacts/ptcg-battle-lab/runs/report.<run-id>.md` — the human-readable, evidence-qualified report.

Both are **regenerable** on demand from the raw logs (they are git-ignored) and are asserted free of
secrets / host paths before every write.

### Never assert a ranking without evidence (順位確定 / 順位未確定)

The ranking order is always winRate-desc, but it is reported as **順位確定** *only* when **both** hold:

1. every adjacent pair's Wilson 95% CIs are **separated** (no overlap), and
2. every agent has **≥ `--min-sample`** decided matches (default 30).

Otherwise the report says **順位未確定** and states why — `CI重複: matsu↔take` for an overlapping
adjacency, `サンプル不足(decided<N): …` for a thin sample — and lists the same points under `## Warnings`
along with any `faults present`. So a rank is never claimed on insufficient statistical basis.

### Diff vs past runs

`--baseline <run-id>` loads that run's `aggregate.<run-id>.json` and adds a per-agent winRate / decided
**delta** table to the report. (It also accepts a battle-lab `aggregate` shape as the baseline.)

### Linear / Discord tracking (run-id + report link)

`analyze --notify` posts a one-line update via `scripts/ai/notify_discord.sh` carrying the **run-id**,
ranking verdict, standings summary, fault count, and the **report path** — so a run is traceable from
Discord. The same line (`buildNotification`) is what the **Linear Completion Report** references, so the
human can follow run-id → report from either channel. Notification is best-effort and never fails the
analyze.

## `smoke` — real-repository end-to-end check (fault 0)

```bash
tsx src/ptcg-battle-lab-cli.ts smoke --run-id sot1711-smoke --matches 40
```

`smoke` resolves the **real** contestant inputs from the sibling checkouts (`ptcg-agent-matsu/take/ume`
— their actual commit SHA + `deck.csv` hash) and runs a small **fault-free** deterministic round-robin,
then analyzes it. It **asserts fault 0 and that every artifact exists** (manifest, object logs,
`aggregate.json`, `report.md`) and exits non-zero otherwise. It uses the deterministic fault-free runner
(not the cabt engine) so it is reproducible in the control-plane / CI; use `run --runner python` for a
real-engine battle where the engine + sibling venvs are available.

## Running with the repository left unspecified

Every path has a safe default rooted at the control-plane checkout, so **no repository needs to be
specified**:

- `--siblings-root` defaults to the control-plane's parent directory (where `ptcg-agent-*` are cloned),
  so `preflight` / `smoke` / `run` find the contestants automatically.
- `--dir` (manifests + analyze artifacts) and `--store` (object store) default under
  `artifacts/ptcg-battle-lab/`.
- `run`/`analyze` require only `--run-id`. Override any default explicitly only when working off a
  non-standard layout.

Repository-less Linear requests that contain a PTCG intent are resolved through
`config/ptcg_profiles.json`. The schema-validated profile pins the 松・竹・梅 remotes, local checkout
paths, branches, decks, run defaults, and this repository as the canonical harness. An explicit
repository or Linear Project always wins. Set `PTCG_PROFILE_ENABLED=0` to disable this fallback and
retain the normal repository resolution behavior.

Before a real run, perform the bounded, offline environment check:

```bash
tsx src/ptcg-profile-cli.ts preflight
```

It checks repository presence, Python environment metadata, decks, the harness entrypoint, and schema
compatibility. Diagnostics use stable profile names and never print local/host paths or secrets.

## Resume & failure diagnosis

- **Resume:** re-invoke `run` with the same `--run-id`. Completed shards are skipped; each shard's
  manifest update is atomic, so an interruption anywhere leaves a valid manifest to resume from, and
  `recordShardResult` refuses to re-record a completed shard (no double-count).
- **`status --run-id <id>`** shows `done/total` shards and per-shard checkboxes.
- **Diagnosing a failure:**
  - `no manifest for run <id>` from `analyze` → the run was never started with that `--run-id`, or `--dir`
    points elsewhere. Run `status` / `run` first.
  - `object … checksum mismatch` / `size mismatch` from `analyze` → a raw log object was truncated or
    edited; the object store is corrupt for that shard. Re-run that shard (delete the object and the
    shard entry, or start a fresh `--run-id`).
  - `manifest … failed validation` / `schema … != expected` → the manifest predates the current schema
    or was hand-edited; re-run under a new `--run-id`.
  - `artifact contains disallowed content` on save → an input leaked a host path / secret (e.g. an
    absolute `repo`); fix the input so only repo **names** and content **hashes** are recorded.
  - `smoke: sibling repo(s) not resolvable` → the `ptcg-agent-*` checkouts are missing under
    `--siblings-root`; clone them or pass the correct root.

## Retention

- **Kept in git (durable):** `manifest.<run-id>.json` — the small, redacted, checksum-referenced record
  of a run. It is the source of truth for what a run was and points at (now absent) raw logs by checksum.
- **Regenerable, git-ignored (transient):** the object store (`objects/…`, raw `games.jsonl`) and the
  analyze outputs (`aggregate.<run-id>.json`, `report.<run-id>.md`). Recompute them from the raw logs
  with `analyze` whenever needed. Prune old `objects/<run-id>/` directories to reclaim space; the manifest
  still documents the run, but `analyze` for that run then requires the objects to be regenerated (re-run).

## Code

- `src/lib/ptcgBattleLab.ts` — pure/deterministic orchestration, object store, manifest lifecycle,
  aggregation, redaction, schema validation.
- `src/lib/ptcgAnalyze.ts` — raw-record readback, per-agent/seat/pair/deck statistics, Wilson-CI-overlap
  ranking (順位確定/未確定), diff, report rendering, notification line (SOT-1711).
- `src/ptcg-battle-lab-cli.ts` — the single CLI entrypoint (`run` / `total-battle` / `status` /
  `analyze` / `smoke` / `preflight`).
- `src/__tests__/ptcgBattleLab.test.ts` — fixture preflight → battle → artifact integration plus the
  interruption / resume / duplicate-rejection / atomicity / schema-validation / redaction tests.
- `src/__tests__/ptcgAnalyze.test.ts` — raw-record readback, tallies, ranking-evidence (CI overlap /
  sample-insufficiency), diff, report rendering, and on-disk artifact regeneration tests.
