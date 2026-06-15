Created the task check report at [docs/ai/60_worker_codex_report.md](/workspaces/ai-dev-control-plane/docs/ai/60_worker_codex_report.md).

I only added/updated that report file. Existing unrelated workspace changes are present in `.claude/settings.local.json` and `.tmp_ai-dev-test4/`; I left them untouched.
contains a partial runner/queue implementation that needs to be consolidated rather than created from scratch.

## Existing Files Found
- `src/runner.js` - existing shared runner helper with lock, queue, usage-limit, Linear API, and eligibility helpers.
- `src/webhook-server.js` - webhook server with Linear webhook handling, Discord webhook handling, local `triggerRun()`, `runItem()`, and `drainQueue()` logic.
- `src/runner-cli.js` - CLI helpers for classification, usage-limit parsing, notification, and label cleanup.
- `scripts/ai/scheduler.sh` - scheduler still directly invokes `scripts/ai/run_auto.sh` and has its own shell lock/retry/usage-limit flow.
- `src/lib/discordCommandHandlers.js` - Discord `/status`, `/queue`, `/cooldown`, `/retry`, pause/resume, and reply handlers; `/retry` enqueues through `runner.enqueue()`.
- `src/__tests__/runner.test.js` - tests for lock, queue, and current usage-limit cooldown file behavior.
- `src/__tests__/webhookServer.test.js` - webhook behavior tests, including cooldown/queue/eligibility cases.
- `docs/ai/auto_logs/runner.queue.json` - persistent queue exists and currently contains multiple webhook-triggered items, including `SOT-578`.
- `docs/ai/auto_logs/runner.cooldown.json` - not found.
- `docs/ai/auto_logs/runner.lock` - lock file exists.
- `docs/ai/auto_logs/scheduler.log` and `docs/ai/auto_logs/auto_runner.log` - scheduler/runner logs exist.
- `README.md` - documents current split behavior, explicitly saying scheduler retry is still in-memory and webhook retry uses `runner.queue.json`.
- `package.json` - has `npm run lint` and `npm test`.

## Current State Assessment
1. Create common runner module: partial. `src/runner.js` exists and centralizes lock, queue, cooldown, Linear helpers, and eligibility checks, but the actual execution pipeline (`triggerRun()`, `runItem()`, `drainQueue()`) still lives inside `src/webhook-server.js`, not in the common runner module.
2. Share persistent queue between scheduler and webhook: partial. `runner.queue.json` and queue helpers exist and webhook/Discord use them. Scheduler does not enqueue work through this queue; it still directly invokes `run_auto.sh`.
3. Persist cooldown state to `runner.cooldown.json`: partial/not aligned. Cooldown persistence exists, but the code uses `docs/ai/auto_logs/runner.usage-limit.json` via `USAGE_LIMIT_FILE`, not the requested `runner.cooldown.json`. The requested file is absent.
4. Change scheduler to enqueue-based: not started. `scripts/ai/scheduler.sh` directly polls Linear, acquires its own shell lock, invokes `scripts/ai/run_auto.sh`, and handles usage-limit retry with sleep loops.
5. Change webhook to go through common runner: partial. Webhook uses `src/runner.js` for queue/lock/cooldown helpers, but still owns execution and drain functions locally.
6. Connect Discord `/retry` and `/queue` to common queue: done/partial. `/retry` uses `runner.enqueue()` and `/queue` uses `runner.loadQueue()`. It does not appear to trigger a queue drain after retry enqueue, so execution still depends on webhook/scheduler activity.
7. Unify usage-limit detection and handling: partial. Parsing is shared via `src/lib/usageLimitParser.js` and webhook uses runner cooldown helpers. Scheduler still parses and handles usage-limit separately in shell and waits in-memory before forced rerun.
8. Unify lock failure handling: partial. Both use `runner.lock` path and similar stale-lock behavior, but scheduler has a separate shell implementation and does not requeue on lock failure; webhook re-enqueues.
9. Add queue drain logic: partial. `drainQueue()` exists in `src/webhook-server.js` and runs after webhook-triggered work, but it is not exported/shared as common runner logic and scheduler does not use it.
10. Improve queue/cooldown file safety: partial. Queue and current usage-limit files are written with temp-file then rename. Parse failures return empty/null but do not visibly preserve corrupt files or recover them with diagnostics. Cooldown filename also does not match the issue requirement.
11. Update README and docs: partial. README documents current behavior clearly, including known future scheduler integration. It still describes split scheduler/webhook behavior rather than the SOT-578 target unified pipeline.
12. Add test/verification scripts: partial. Jest tests exist for runner and webhook behavior, and `npm test` is available. Tests need updates for scheduler enqueue behavior, common runner execution/drain APIs, `runner.cooldown.json`, and unified lock/usage-limit semantics.

## Actionability
- Is this task actionable? YES
- Reason: The codebase already has enough structure to implement SOT-578 incrementally. The main implementation work is to move execution/drain logic from `src/webhook-server.js` into `src/runner.js` or `src/lib/runner.js`, make scheduler enqueue/drain through that common module instead of invoking `run_auto.sh` directly, standardize cooldown persistence to the requested `runner.cooldown.json`, and update Discord/webhook/docs/tests around the shared pipeline.

## Key Files to Modify
- `src/runner.js` - centralize run execution, queue drain, usage-limit handling, lock failure requeue behavior, and cooldown filename/API.
- `src/webhook-server.js` - remove local execution/drain ownership and call the common runner pipeline.
- `scripts/ai/scheduler.sh` - stop direct `run_auto.sh` execution path; enqueue and/or invoke a runner drain command.
- `src/runner-cli.js` - likely add commands such as enqueue/drain/status/cooldown or adapt existing commands for scheduler use.
- `src/lib/discordCommandHandlers.js` - optionally trigger common drain after `/retry`, and update cooldown/queue reporting if APIs change.
- `src/__tests__/runner.test.js` - update/add tests for common pipeline, `runner.cooldown.json`, parse recovery, atomic writes, lock requeue, and drain.
- `src/__tests__/webhookServer.test.js` - update webhook tests to assert delegation to common runner.
- `README.md` - update current split-behavior docs to the unified scheduler/webhook/Discord pipeline.
- `package.json` - possibly add verification scripts if new task-specific checks are introduced.

## Risks
- Existing queue file currently contains live items, including `SOT-578`; implementation should avoid destructive queue migration.
- The issue specifically asks for `runner.cooldown.json`, but current tests and code use `runner.usage-limit.json`; a migration/backward-compatibility path may be needed.
- Moving `runItem()` and `drainQueue()` out of `webhook-server.js` may affect tests that currently mock child processes and webhook async behavior.
- Scheduler is shell-based and contains duplicated lock/usage-limit logic; replacing it with Node runner commands should preserve `stop`, `status`, `--watch`, `--foreground`, logging, and Discord buffer behavior or explicitly simplify them.
- Queue file writes are atomic within one process but no explicit file-level lock protects concurrent enqueue/dequeue writes from multiple Node processes. A unified runner may need serialization or lock coverage around queue mutation.
- Webhook currently dequeues immediately after enqueueing; if multiple events arrive concurrently, ordering and duplicate prevention should be tested carefully.

## Next Action
READY_FOR_REVIEW
