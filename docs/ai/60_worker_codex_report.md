# Worker Report

## Summary
SOT-931 follow-up #3 (IMPLEMENT). Latest human instruction (2026-06-20T16:11:59Z):
「案Aを採用するが、現行の『同一 repo は直列』制約と『同一 branch だけ直列／別 branch は並行可』を
切り替えられるようにしてください。」→ adopt 案A, and make the write-side serialization constraint
**switchable** between per-repo serial (current) and per-branch serial (different branches parallel).

This run implemented the **first 案A step**: a switchable serialization-scope primitive
(`RUNNER_SERIALIZE_SCOPE`) that controls how the runner lane key is derived.

## Worker Non-Response Disclosure (audit sink)
- Non-responsive workers:
  - **Codex CLI** (assigned the initial task check): `run_codex.sh` exited **75** (CODEX_COOLDOWN_ACTIVE,
    usage-limit cooldown until epoch 1782000900). Dedicated non-response code per Worker Non-Response Policy.
  - **Gemini CLI** (would own IMPLEMENT): permanently non-responsive — `run_gemini.sh` hard-fails exit 75
    (IneligibleTierError, free tier unsupported) per project history.
- Detected failure mode: both workers unavailable (cooldown / ineligible tier).
- Fallback: **Claude Code performed the implementation + verification directly.** Bounded retry not
  applicable (both are hard gates). All Quality Gates applied identically (lint/typecheck/test below).

## Implementation (Claude Code fallback)
- `src/runner.ts`:
  - `RUNNER_SERIALIZE_SCOPE` resolver (`resolveSerializeScope`): `branch` → per-branch serial,
    anything else → `repo` (default = current "同一 repo は直列").
  - `serializationLaneKey({repo, branch, scope})`: scope=repo → lane = sanitized repo; scope=branch →
    lane = `repo--branch` (別 branch = 別 lane = 並行可、同一 branch = 直列). Empty repo → DEFAULT_LANE.
  - `resolveLane()` precedence updated: explicit non-default `RUNNER_LANE` wins (backward compat);
    else under branch scope derive lane from `RUNNER_REPO`/`RUNNER_BRANCH`; else DEFAULT_LANE.
  - Lane keys stay sanitized to `[a-zA-Z0-9_-]` (cannot escape LOG_DIR). Reuses existing
    `laneLockFile`/`laneQueueFile` lock/queue separation — no change to that machinery.
- Follow-ups (NOT in this step): worktree provisioning, N-slot semaphore worker pool
  (`RUNNER_MAX_PARALLEL`), default-detach. These are the heavier 案A pieces, to be separate IMPLEMENT issues.

## Changed Files
- `src/runner.ts` — serialization-scope resolver + lane-key derivation + resolveLane wiring + exports
- `src/__tests__/runner.test.ts` — 8 new tests (scope resolution, repo vs branch lane keys, sanitization,
  explicit-lane precedence, RUNNER_REPO/RUNNER_BRANCH derivation, default backward-compat)
- `docs/runner-queue.md` — new section「直列スコープの切替（RUNNER_SERIALIZE_SCOPE / SOT-931, 案A）」

## Commands Run
- `bash scripts/ai/run_codex.sh` → exit 75 (cooldown; non-responsive)
- `npm run typecheck` → exit 0
- `npm run lint` → exit 0
- `npm test` → exit 0 (28 suites, **411 tests pass**; +9 from the new scope tests)
- e2e: N/A (no `e2e` script)

## Acceptance Criteria
- [x] Serialization constraint is switchable (`RUNNER_SERIALIZE_SCOPE=repo|branch`)
- [x] Default (`repo`) preserves current "同一 repo は直列" behavior (backward compatible)
- [x] Branch scope gives 別 branch independent lanes (並行可) while 同一 branch stays serial (直列)
- [x] Lane keys remain LOG_DIR-safe; explicit RUNNER_LANE still wins
- [x] lint / typecheck / full test suite green

## Risks
- This step only switches the lane-key **derivation**. Safely running 同一 repo・別 branch concurrently
  in practice still needs worktree provisioning + a parallel worker pool (later 案A steps); until then,
  branch scope yields independent lock/queue lanes but the operator must avoid two checkouts of one
  working tree. Documented in `docs/runner-queue.md`.

## Next Action
READY_FOR_REVIEW
