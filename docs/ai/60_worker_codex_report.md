Wrote the initial task-check report to [docs/ai/60_worker_codex_report.md](/workspaces/ai-dev-control-plane/docs/ai/60_worker_codex_report.md:1).

Validation completed:
- `npm run lint`: pass
- `npm test`: pass, 9 suites / 151 tests

Next action in the report is `READY_FOR_REVIEW`.
and tests around parser/queue/cooldown. The requested safe resume flow is mostly missing: no `--resume` mode, no resume-specific Claude prompt, no resume metadata JSON, no session-continue/tmux runner, no limit-type classification, and no unified resume-start checkpoint/log/comment flow.

## Issue Status Check
- Linear status: `In Progress` / statusType `started`; priority `High`; labels: none; assignee: sota morohashi.
- Latest comments: four repeated comments from 2026-06-16T10:43:52Z through 2026-06-16T10:44:25Z, all `usage-limit: Next auto run: 2026-06-16 23:10 JST`.
- completed|canceled|archived|duplicate: no. `completedAt`, `canceledAt`, `archivedAt` are null and `duplicateOf` is null. Note state history shows it was briefly `Canceled` earlier on 2026-06-16, then moved back to `Todo` and `In Progress`.
- Acceptance criteria summary: save resume metadata on usage-limit; issue-rerun resumes with a resume prompt after reset+buffer; session-continue resumes an explicit tmux pane after foreground Claude Code verification; log resume checkpoint data; update Linear state/label/comment at resume start; skip terminal/archived/duplicate issues; ensure queue priority matches README and No priority is last; unify scheduler/webhook/Discord/manual resume path; classify non-session limit errors so weekly/auth/etc. do not short-retry; preserve normal flow and keep session-continue opt-in.

## Codebase Findings
- usage-limit parser: [src/lib/usageLimitParser.js](/workspaces/ai-dev-control-plane/src/lib/usageLimitParser.js:8) exports `parseUsageLimitResetEpoch(text, nowMs)`. It checks reset-ish keywords, extracts optional IANA timezone/date/time, and returns an epoch with `USAGE_LIMIT_RETRY_BUFFER_SECONDS` already added at [src/lib/usageLimitParser.js](/workspaces/ai-dev-control-plane/src/lib/usageLimitParser.js:68). It does not classify `session_limit`, `weekly_limit`, `api_429`, `auth_error`, `network_error`, `model_unavailable`, `context_limit`, etc.; it only returns epoch or null. Risk: [src/runner.js](/workspaces/ai-dev-control-plane/src/runner.js:1125) treats that epoch as reset, then adds buffer again for `retryAt` at [src/runner.js](/workspaces/ai-dev-control-plane/src/runner.js:1129), so current code likely double-buffers.
- cooldown: [src/runner.js](/workspaces/ai-dev-control-plane/src/runner.js:367) writes `docs/ai/auto_logs/runner.cooldown.json` with `active`, `until`, `detectedAt`, `sourceIssueId`, `sourceIssueIdentifier`, `resetAt`, `bufferSeconds`, and also writes legacy `runner.usage-limit.json` with `retryAt`/`issueId` at [src/runner.js](/workspaces/ai-dev-control-plane/src/runner.js:403). [src/runner.js](/workspaces/ai-dev-control-plane/src/runner.js:429) returns only `{ retryAt, issueId, issueIdentifier, active }`, clearing expired cooldowns. It does not return cooldown reason/type.
- queue + priority: README says ready items only, priority Urgent/High/Medium/Low/No priority, child group priority after Linear priority with Urgent always first ([README.md](/workspaces/ai-dev-control-plane/README.md:444)). Implementation maps priority `0`/null/undefined to rank 5 at [src/runner.js](/workspaces/ai-dev-control-plane/src/runner.js:167), so No priority does not sort first. `dequeue()` filters future `retryAt` out at [src/runner.js](/workspaces/ai-dev-control-plane/src/runner.js:781), checks Urgent first at [src/runner.js](/workspaces/ai-dev-control-plane/src/runner.js:829), then child group after last processed parent at [src/runner.js](/workspaces/ai-dev-control-plane/src/runner.js:842), then general priority/retry/enqueued order at [src/runner.js](/workspaces/ai-dev-control-plane/src/runner.js:857). This matches the README’s current detailed text, but differs from the issue’s acceptance wording if interpreted strictly as `retryAt -> Urgent -> child-after-parent -> High -> Medium -> Low -> No priority -> enqueuedAt`.
- run_auto.sh resume: [scripts/ai/run_auto.sh](/workspaces/ai-dev-control-plane/scripts/ai/run_auto.sh:17) always uses `prompts/claude/auto_run.md`; only `--dry-run` is parsed at [scripts/ai/run_auto.sh](/workspaces/ai-dev-control-plane/scripts/ai/run_auto.sh:31). There is no `--resume SOT-xxx` handling. Runner starts it without resume args via [src/runner.js](/workspaces/ai-dev-control-plane/src/runner.js:1046) and passes only `WEBHOOK_ISSUE_ID`.
- prompts (normal vs resume): normal prompt exists at [prompts/claude/auto_run.md](/workspaces/ai-dev-control-plane/prompts/claude/auto_run.md:1). It already tells normal runs to set In Progress and remove `usage-limit` label at [prompts/claude/auto_run.md](/workspaces/ai-dev-control-plane/prompts/claude/auto_run.md:51). No resume-specific prompt exists; `find prompts/claude` shows only `prompts/claude/auto_run.md`.
- resume metadata json: absent. `docs/ai/auto_logs/resume` does not exist, and no code writes `docs/ai/auto_logs/resume/*.json`.
- session-continue / tmux: no runtime code for `session-continue`, pane monitoring, foreground process validation, or `tmux send-keys`. Existing tmux references are documentation/setup only, e.g. [README.md](/workspaces/ai-dev-control-plane/README.md:214) and `docs/tmuxinator-setup.md`.
- Discord commands: slash commands are registered for `/status`, `/queue`, `/cooldown`, `/pause`, `/resume`, `/reply`, `/retry`, `/ask` at [scripts/register_discord_commands.js](/workspaces/ai-dev-control-plane/scripts/register_discord_commands.js:15). Routing handles those commands at [src/lib/discordCommandRouter.js](/workspaces/ai-dev-control-plane/src/lib/discordCommandRouter.js:69). Current `/resume` only clears pause state at [src/lib/discordCommandHandlers.js](/workspaces/ai-dev-control-plane/src/lib/discordCommandHandlers.js:152); it does not support `/resume issue` or `/resume session pane:%12`. `/status`, `/queue`, `/cooldown` expose current lock/queue/cooldown at [src/lib/discordCommandHandlers.js](/workspaces/ai-dev-control-plane/src/lib/discordCommandHandlers.js:22).
- existing tests: parser tests cover reset-time extraction only at [src/__tests__/usageLimitParser.test.js](/workspaces/ai-dev-control-plane/src/__tests__/usageLimitParser.test.js:3). Runner tests cover cooldown persistence at [src/__tests__/runner.test.js](/workspaces/ai-dev-control-plane/src/__tests__/runner.test.js:87), No priority last at [src/__tests__/runner.test.js](/workspaces/ai-dev-control-plane/src/__tests__/runner.test.js:249), future `retryAt` skip at [src/__tests__/runner.test.js](/workspaces/ai-dev-control-plane/src/__tests__/runner.test.js:294), child-after-parent at [src/__tests__/runner.test.js](/workspaces/ai-dev-control-plane/src/__tests__/runner.test.js:304), and usage-limit retry re-enqueue metadata preservation at [src/__tests__/runner.test.js](/workspaces/ai-dev-control-plane/src/__tests__/runner.test.js:367). No tests for limit classification, resume metadata generation, resume prompt selection, or tmux/session-continue behavior.

## Commands Run
- `mcp__linear.get_issue` for `SOT-637`: succeeded; issue is active and not terminal/archived/duplicate.
- `mcp__linear.list_comments` for `SOT-637`: succeeded; four latest comments are repeated usage-limit retry notices.
- `rg --files`: succeeded.
- `rg -n "usage-limit|usage limit|usage_limit|resetAt|retryAt|cooldown|resume|--resume|tmux|session-continue|queue|priority|Discord|slash|run_auto" -S .`: succeeded.
- `find docs/ai/auto_logs -maxdepth 3 -type f`: succeeded; no resume metadata directory found.
- `npm run lint`: pass.
- `npm test`: pass, 9 suites / 151 tests.
- package scripts: `lint`, `auth:setup`, `start:webhook`, `start:ngrok`, `dev:webhook`, `test` in [package.json](/workspaces/ai-dev-control-plane/package.json:6). No `typecheck` or `e2e` script, so typecheck/e2e are N/A.

## Acceptance Criteria
- [ ] resume metadata JSON saved on usage-limit: missing.
- [ ] issue-rerun uses reset+buffer and resume-specific prompt: missing; current retry uses normal `auto_run.md`.
- [ ] session-continue sends `continue` to tmux pane after reset+buffer: missing.
- [ ] session-continue checks foreground process is Claude Code: missing.
- [ ] foreground mismatch notification: missing.
- [ ] resume logs target issue, mode, branch, git status, previous log: missing.
- [ ] resume start moves issue to In Progress: partially present in normal prompt and runner helper, not a resume-start flow.
- [ ] resume start removes usage-limit label: partially present in normal prompt and success cleanup, not a resume-start flow.
- [ ] completed/canceled/archived/duplicate skipped: present for queue/webhook execution eligibility at [src/runner.js](/workspaces/ai-dev-control-plane/src/runner.js:1004).
- [ ] No priority not highest: present and tested.
- [ ] queue README priority ordering: mostly present; clarify issue wording vs README child-group position.
- [ ] scheduler/webhook/Discord/manual share same resume processing: missing.
- [ ] auth/weekly/non-usage errors do not short-retry: missing; parser has no classification.
- [ ] normal flow preserved: current tests pass before changes.
- [ ] session-continue opt-in only: missing because feature does not exist.

## Risks / Decomposition Recommendation
This should be decomposed into child issues rather than one PR. It spans parser semantics, queue/cooldown schema, shell runner UX, Linear side effects, Discord commands, tmux process control, logging, and docs. Recommended breakdown:

1. Parser/cooldown foundation: replace epoch-only parser with typed classification object, fix resetAt/retryAt buffer semantics, add fixtures/tests for session/weekly/auth/network/unknown.
2. Resume metadata and safe checkpoint logging: write `docs/ai/auto_logs/resume/<issue>.json`, capture git/branch/log/exit/cooldown/queue data, and add tests.
3. Issue-rerun resume mode: add `run_auto.sh --resume <issue>`, resume prompt, runner resume path, Linear state/label/comment updates, and ensure terminal issues are skipped.
4. Queue ordering/doc alignment: explicitly settle issue acceptance wording vs README, add comparator tests for child-after-parent relative to High/Medium/Low and ready `retryAt` ordering.
5. Session-continue runner: add explicit opt-in command/API, tmux pane capture, foreground process validation, continue send, failure notifications, and manual/test coverage.
6. Discord/control surfaces and docs: add `/resume issue`, `/resume session`, richer `/cooldown`/`/status`, update README and operational docs.

Primary risks: double-buffer behavior may already affect retry timing; cooldown schema changes need backward compatibility with `runner.usage-limit.json`; tmux foreground detection is platform-sensitive; Linear label updates can trigger webhooks, so dedupe/non-meaningful update handling must be preserved; Discord `/resume` currently means “clear pause,” so new subcommands must avoid breaking that behavior.

## Next Action
READY_FOR_REVIEW
