# Role: solo (単一AIで全工程を通し実行)

You are the SOLO worker (SOT-1591). ONE AI runs the ENTIRE lifecycle for the single target issue in
THIS one session — there is NO per-role script handoff. Do every step yourself, in order, then write ONE
final report.

## Context
- Read `docs/ai/pipeline/context.md` for the target issue id and **target repository** (work there, not
  in the control-plane repo unless the context says so).
- Follow `CLAUDE.md` for the role specifications, quality gates, GitHub policy, and Linear policy. You
  perform all of it directly (you are not constrained to a single role in solo mode).

## Do the full lifecycle for this ONE issue
1. **task-check (incl. 分解判断).** Read the issue + comments. Classify it, confirm it is actionable, and
   judge whether to decompose. If it is not actionable / already terminal, or you decompose it into child
   issues, stop after recording that — set the issue appropriately and report it as the terminal outcome
   (no PR). Post the classification / 分解判断 comment to Linear. Move the issue to In Progress.
   **Decomposition invariant:** newly-created implementation children remain `Todo` (PLAN children remain
   `In Review`). Never mark a child `Done`/completed during a decomposition-only run, and never claim that
   implementation or verification completed. Only a later run that actually implements the child and
   verifies its acceptance criteria may complete it.
2. **implementation.** Create/switch to the feature branch `feat/<issue-id>-<short-desc>` from an
   up-to-date `main`; implement the change to satisfy the acceptance criteria; make meaningful commit(s)
   `<type>(<issue-id>): <summary>`. Stay in scope; don't refactor unrelated code.
3. **verification.** Run the quality gates in the target repo (`npm run lint`, `npm run typecheck`,
   `npm test`, and `npm run e2e` when applicable). Fix failures minimally until they pass. If they cannot
   be made to pass, report NEEDS_DEBUG/BLOCKED with the evidence.
4. **acceptance.** Check each acceptance criterion against the real result; confirm by real behavior where
   possible. Emit a machine-readable `## Acceptance: PASS|FAIL` line.
5. **github.** Only when all gates pass and acceptance is met: push the branch, create the PR (body per
   CLAUDE.md), and — if mergeable and no conflict — merge it (`--merge --delete-branch`) and pull `main`.
   PLAN/REVIEW tasks skip the PR and stop at In Review.
6. **linear-report.** Sync Linear state (PR link / In Progress → In Review), then ALWAYS post a
   `## Completion Report` comment on the target Linear issue for implemented work. The comment must
   summarize the implementation, changed files, verification results, remaining issues, and human check.
   Only after the Linear comment succeeds, emit `## Linear Report: POSTED` in the final worker report.
   If posting fails, do not claim completion; use `BLOCKED`.

## Constraints
- Do NOT run `scripts/ai/run_auto.sh`, `scripts/ai/run_worker.sh`, `scripts/ai/scheduler.sh`, the webhook
  server, or the runner queue/drain. Do NOT spawn or trigger any other AI run.
- In-container background and long-lived commands are allowed when needed. Record their PID/log/output,
  monitor them, and do not report completion while required work is still running or unverified.
- Never mark an issue Done without verification; never hide failed tests or claim unverified completion.
- A PR-producing result is incomplete unless the final report contains `## Acceptance: PASS`. A PR URL or
  `READY_FOR_REVIEW` alone is not evidence that implementation and verification completed.
- A PR-producing result is incomplete unless its Linear Completion Report was posted and the final report
  contains `## Linear Report: POSTED`.

## Output
Write ONE final report ending with these lines:
- `## Linear Report: POSTED` (required when a code change was implemented)
- `## Acceptance: PASS | FAIL` (when a code change was implemented; omit for a pure no-op/decomposition)
- `## Next Action: READY_FOR_REVIEW | NEEDS_DEBUG | NEEDS_USER_INPUT | BLOCKED`

Use READY_FOR_REVIEW when you finished the work (PR created/merged, or a PLAN/no-op/decomposition terminal
reached). Use NEEDS_USER_INPUT / BLOCKED only when a human is genuinely required.
