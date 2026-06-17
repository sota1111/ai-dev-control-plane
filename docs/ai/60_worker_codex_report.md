# Worker Report

## Summary
Verified the Node scheduler port against the legacy Bash scheduler without starting daemon/watch/default-start paths and without making Linear or Discord network calls. Full quality gate passed. No code fixes were required.

## Commands Run
- npm run lint: 0
- npm run typecheck: 0
- npm test: 0, 242/242 passing across 19/19 suites; pre-existing tests still pass
- smoke: schedulerCore require / `scheduler.js status`: `node -e "require('./src/lib/schedulerCore.js')"` exited 0; `node src/scheduler.js status` exited 0 and printed `Scheduler is not running`
- e2e: N/A, no `e2e` script

## Parity Review
- `.env` loading uses `dotenv.config({ path: <repo>/.env, override: false })`, preserving existing environment values like the Bash loader.
- Defaults match legacy: `INTERVAL=3600`, `CHECK_INTERVAL=60`, `WEBHOOK_MODE=false`.
- Fixed paths match legacy: PID `/tmp/l-concierge-scheduler.pid`, logs under `docs/ai/auto_logs/`, `linear_state.txt`, and `runner.queue.json`.
- Default command exits early for `WEBHOOK_MODE=true` with the same user-facing Japanese messages; `stop`, `status`, `--watch`, and `--foreground` bypass the top-level early exit. Foreground still performs the legacy foreground-specific webhook-mode log-and-exit path.
- Scheduler log lines use `[YYYY-MM-DD HH:MM:SS] [SCHEDULER] <msg>` and append to both `auto_runner.log` and `scheduler.log`. Discord buffering is only enabled when `DISCORD_WEBHOOK_URL` is set; Node buffers complete newline-terminated lines similarly to Bash.
- `stop` and `status` output wording matches the legacy user-facing messages, including stale PID wording.
- `--foreground` writes the PID file, ignores SIGINT, handles SIGTERM cleanup, waits for an in-flight drain, drains pending queue on restart recovery when the queue JSON array has entries, and preserves Linear-polling versus fixed-interval fallback loops.
- Drain is executed via `node src/runner-cli.js drain`. Linear polling enqueues active identifiers with trigger `scheduler` before draining.
- Linear active issue query includes `state.type in ["unstarted", "started"]`, `orderBy: priority`, `first: 10`, and fetches identifiers.
- Rollback wrapper is correct: `scripts/ai/scheduler.sh` execs Node by default and execs `scripts/ai/scheduler.legacy.sh` when `SCHEDULER_IMPL=bash`.
- `scripts/ai/scheduler.legacy.sh` matches `origin/main:scripts/ai/scheduler.sh` exactly by diff.
- Minor caveat: legacy restart recovery drains when `runner.queue.json` exists and is non-empty; Node drains when it parses as a non-empty JSON array. This is equivalent for the normal queue format used by `runner.js`, but corrupt non-empty queue content would no longer trigger a scheduler drain.
- Minor caveat: legacy Linear enqueue uses `runner-cli.js enqueue` and appends that CLI output to `auto_runner.log`; Node calls `runner.enqueue()` directly. The queue trigger is preserved as `scheduler`, but CLI enqueue stdout is not reproduced.

## Changed Files
- `docs/ai/60_worker_codex_report.md` — verification report

## Acceptance Criteria
- [x] スケジューラの主要機能がNode/TSで再現されている
- [x] 互換wrapperでロールバック可能 (SCHEDULER_IMPL=bash → legacy)
- [x] 既存運用フロー（enqueue/drain/通知）が維持されている

## Risks
Remaining risk is limited to unexercised daemon behavior because the instructions explicitly prohibited starting default, `--foreground`, or `--watch` modes. Static review found only the two minor parity caveats noted above.

## Next Action
READY_FOR_REVIEW
