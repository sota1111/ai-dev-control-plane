# Runner parallel execution — different-project Todos run concurrently

The autonomous runner can process Todos from **different projects (= different repositories) concurrently**,
while work on the **same repository stays strictly serial**. This lets independent projects — e.g. a
an implementation request in one repository, a request in another repository, or
any app-dev project registered in Linear — make progress at the same time when each has a Todo.

Nothing is forced to launch simultaneously. Issues are created by humans or approved upstream
producers such as `epistemic-research-loop`; whenever Todos of different projects coexist in the
queue, they drain in parallel.

## How it works

- **Selection lane = target repo.** `drainQueuePooled` (`src/runner.ts`) resolves each queued issue's
  serialization lane from its Linear project → repo (`resolveConcurrencyLane`). Distinct repos → distinct
  lanes → run concurrently; the **same lane (= same repo) never runs two items at once** (the safety
  valve that prevents index/worktree corruption). This is the "別のリポジトリに限定" guarantee.
- **Per-lane scratch isolation.** Lock files, the queue, and the per-worker prompt files are already
  lane-suffixed (SOT-933). Linear GraphQL is the context source of truth. Each pipeline stores its
  structured transport snapshot at `docs/ai/pipeline/context.<issue>.json` and exports its absolute
  path as `PIPELINE_CONTEXT_JSON_FILE`. Readers (`run_worker.sh`, `run_discussion.sh`) and worker
  preambles (`run_claude.sh`, `run_codex.sh`) therefore cannot read another concurrent run's issue.

## Configuration — `config/runner.json` (source of truth, NOT `.env`)

```json
{ "maxParallel": 2, "serializeScope": "repo", "stableMode": false }
```

- `maxParallel` — how many distinct-lane items drain concurrently. `1` = fully serial (historical).
- `serializeScope` — `repo` (同一repo直列/別repo並行, default) | `branch` (別branchも別lane).
- `stableMode` — `true` forces fully-serial (emergency kill-switch).

Loader: `src/lib/runnerConfig.ts` (pure, fail-open to serial defaults when the file is missing/invalid).
Runtime env vars (`RUNNER_MAX_PARALLEL` / `RUNNER_SERIALIZE_SCOPE` / `RUNNER_STABLE_MODE`) still
**override** the config when explicitly set — use them for a temporary operational change without editing
the committed file. A temporary full halt: `RUNNER_STABLE_MODE=1`.

## Usage-limit note

Two **Claude-lineage** runs in parallel share the account-global usage limit and will consume it N×
faster — this is **accepted** (the pool is intentionally usage-pool-agnostic). Pairing a Claude-lineage
project with a GPT/Codex-lineage project (e.g. `biohub-claude` ∥ `kaggriculture-gpt`) parallelizes across
different providers, so it is free throughput.
