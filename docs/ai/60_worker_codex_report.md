Wrote the task-check report to [docs/ai/60_worker_codex_report.md](/workspaces/ai-dev-control-plane/docs/ai/60_worker_codex_report.md).

Key result: queue/enqueue/drain infrastructure already exists, but webhook server startup bootstrap scanning does not. `npm run lint` and `npm test` pass; `npm run typecheck` is missing from `package.json`.
webhook, runner, queue, scheduler, and environment files. The existing webhook server handles incoming Linear issue webhook events and can enqueue/drain work after an accepted event, but it does not perform a startup bootstrap scan of unprocessed Linear issues when the webhook server starts.

## Changed Files
(none for task check)

## Commands Run
- `test -f docs/ai/00_project_context.md && sed -n '1,240p' docs/ai/00_project_context.md || true`
  - Result: file exists; contains high-level project context.
- `find src -name "*.ts" | grep -v node_modules | grep -v __tests__ | sort`
  - Result: no output; no non-test TypeScript files found.
- `find src -name "webhook*.ts" | grep -v node_modules | sort`
  - Result: no output.
- `find src -name "runner*.ts" | grep -v node_modules | sort`
  - Result: no output.
- `find src -name "queue*.ts" | grep -v node_modules | sort`
  - Result: no output.
- `find src -maxdepth 4 -type f | sort`
  - Result: JavaScript source files found, including `src/webhook-server.js`, `src/runner.js`, `src/runner-cli.js`, and tests.
- `sed -n '1,560p' src/webhook-server.js`
  - Result: inspected webhook server startup and handlers.
- `sed -n '1,1220p' src/runner.js`
  - Result: inspected Linear API helpers, queue persistence, enqueue/dequeue/drain APIs, lock handling, and runner execution.
- `sed -n '1,220p' src/runner-cli.js`
  - Result: inspected CLI commands for `enqueue`, `drain`, and queue status.
- `grep -r "bootstrap" src/ --include="*.ts" | grep -v node_modules`
  - Result: no output.
- `grep -r "startup" src/ --include="*.ts" | grep -v node_modules`
  - Result: no output.
- `grep -r "WEBHOOK_BOOTSTRAP" . --include="*.ts" --include="*.env*" | grep -v node_modules`
  - Result: no output.
- `grep -r "drainQueue\|enqueue" src/ --include="*.ts" | grep -v node_modules | head -30`
  - Result: no output.
- `grep -r "bootstrap" src/ --include="*.js" | grep -v node_modules`
  - Result: no output.
- `grep -r "startup" src/ --include="*.js" | grep -v node_modules`
  - Result: no output.
- `grep -r "WEBHOOK_BOOTSTRAP" . --include="*.js" --include="*.env*" | grep -v node_modules`
  - Result: no output.
- `grep -r "drainQueue\|enqueue" src/ --include="*.js" | grep -v node_modules | head -30`
  - Result: found queue usage in tests and webhook/runner files.
- `cat /workspaces/ai-dev-control-plane/.env.example 2>/dev/null || echo "No .env.example found"`
  - Result: `.env.example` exists. Relevant variables include `LINEAR_API_KEY`, `LINEAR_WEBHOOK_SECRET`, `WEBHOOK_MODE`, `PORT`, `CHECK_INTERVAL`, and `INTERVAL`. No `WEBHOOK_BOOTSTRAP` variable exists.
- `sed -n '160,210p' scripts/ai/scheduler.sh`
  - Result: inspected existing `linear_has_updates` polling helper.
- `sed -n '340,420p' scripts/ai/scheduler.sh`
  - Result: scheduler drains existing queue on startup and polls Linear active issues, but this is not webhook-server startup logic.
- `npm run lint 2>&1 | tail -20`
  - Result: passed; `node --check` completed for configured files.
- `npm run typecheck 2>&1 | tail -20`
  - Result: failed semantically because `typecheck` script is missing from `package.json` (`npm error Missing script: "typecheck"`). The shell pipeline itself exited with tail's status.
- `npm test 2>&1 | tail -30`
  - Result: passed; 9 test suites and 125 tests passed.

## Relevant Files Found
- `src/webhook-server.js` - webhook server entry point; Linear webhook handling and current startup `app.listen`.
- `src/runner.js` - queue persistence, Linear GraphQL helper, issue metadata helper, pending issue check, lock handling, runner execution, and `drainQueue`.
- `src/runner-cli.js` - CLI wrapper for enqueue/drain/status operations.
- `src/__tests__/webhookServer.test.js` - existing webhook behavior tests.
- `src/__tests__/runner.test.js` - existing queue/runner behavior tests.
- `scripts/ai/scheduler.sh` - existing polling scheduler with startup queue drain and active Linear issue polling.
- `.env.example` - environment configuration; no webhook bootstrap-specific variable currently exists.
- `package.json` - scripts and test/lint configuration.

## Current State Assessment
### Exists
- Webhook server starts via `src/webhook-server.js` and logs `[WEBHOOK] Server listening on port ${PORT}`.
- Linear webhook handler accepts `Issue` create/update events, ignores terminal/archived/non-meaningful updates, enqueues accepted issues, runs one item, and drains the remaining queue.
- Queue infrastructure exists in `src/runner.js`:
  - `loadQueue()` / `saveQueue()` persist `docs/ai/auto_logs/runner.queue.json`.
  - `enqueue()` de-duplicates by `issueId` and merges retry/priority/parent metadata.
  - `dequeue()` orders ready items by priority, retry time, enqueue time, and parent grouping.
  - `drainQueue()` processes queued items with lock handling and eligibility checks.
- Linear API helper exists as `linearQuery()`.
- `hasPendingIssues()` exists but only returns a boolean for whether any `unstarted`/`started` issue exists.
- `getIssueQueueMetadata(issueId)` exists for fetching one issue's priority/parent/state metadata.
- `getIssueExecutionEligibility(issueId)` exists to skip missing, archived, and terminal issues before execution.
- `scripts/ai/scheduler.sh` already has similar polling logic outside webhook mode:
  - drains existing queue on scheduler startup;
  - fetches up to 10 active Linear issue identifiers ordered by priority;
  - enqueues them with trigger `scheduler`;
  - drains the queue.

### Needs Implementation
- Add webhook-server startup bootstrap logic, likely near `app.listen()` in `src/webhook-server.js`.
- Add Linear unprocessed issue fetch logic that returns issue nodes/metadata, not just a boolean. Existing `hasPendingIssues()` is insufficient for SOT-619 because it cannot enqueue issue identifiers.
- Reuse `runner.enqueue()` to place fetched active issues into the queue with a distinct trigger such as `webhook-bootstrap`.
- Call `runner.drainQueue()` after bootstrap enqueueing so processing resumes after webhook server restart.
- Add startup scan logging for:
  - bootstrap start;
  - disabled/skipped state if configuration requires it;
  - missing `LINEAR_API_KEY`;
  - number of active Linear issues found;
  - each enqueue or duplicate skip;
  - drain start/end and errors.
- Consider adding an env switch such as `WEBHOOK_BOOTSTRAP_ON_START=true` if the desired behavior should be configurable. No such variable currently exists in `.env.example`.
- Add tests for startup bootstrap behavior. Current webhook tests import the Express app and do not start the listener, so implementation may need a separate exported bootstrap function for testability.

### Risks
- Current `src/webhook-server.js` exports only `app`; startup behavior inside `require.main === module` is not directly exercised by existing tests.
- A bootstrap scan that drains immediately can start long-running AI execution during server startup. This should be intentional and logged clearly.
- `LINEAR_API_KEY` may be absent in webhook deployments that only rely on inbound Linear webhooks. Bootstrap scan cannot work without it.
- Existing scheduler already performs active-issue polling. If scheduler and webhook server run together, duplicate enqueue/drain attempts are possible, though `enqueue()` de-duplicates by `issueId` and lock handling reduces execution overlap.
- Need to define "未処理 Linear Issue" precisely. Existing code treats state types `unstarted` and `started` as active/pending; terminal and archived issues are skipped. If "unprocessed" means a narrower label/status/comment condition, the fetch filter needs adjustment.
- Linear pagination currently matters. Scheduler fetches `first: 10`; runner notification helpers use `first: 50`. Bootstrap acceptance criteria should define how many active issues to scan and whether pagination is required.

## Acceptance Criteria
- [ ] webhook server startup bootstrap scan exists
- [ ] Linear unprocessed issue fetch logic exists
- [x] Queue enqueue logic exists
- [ ] Startup scan logging exists

## Next Action
READY_FOR_REVIEW
