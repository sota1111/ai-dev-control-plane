# CLAUDE.md — AI Harness Specification

## Overview

There is **no single "sole orchestrator."** Each role's worker is configured in
`config/worker_roles.json` (a per-role priority chain) and run via the dispatcher
`scripts/ai/run_worker.sh`. For a targeted issue, `scripts/ai/run_auto.sh` sequences the roles as a
script (see **Worker Dispatch**). Claude, Codex, and Antigravity are peer workers — Claude runs a role
only when that role's chain selects it.

The human steers the system through Linear/Discord and per-issue directives, never by instructing a
worker CLI directly.

---

## Roles

- **Claude Code** — judgment, delegation, final approval. Single point of contact with the human;
  classifies Issues; judges decomposition; writes worker prompts; reviews worker reports; makes the
  quality-gate call; owns **all GitHub ops (branch, PR, merge)** and **Linear state sync**. Claude does
  NOT do large-scale reading, multi-file implementation, repeated lint/test cycles, long log analysis,
  or first-pass diff review. Claude MAY do small wording fixes (1–2 lines), Linear comments, PR
  creation, and final reports.
- **Antigravity CLI** — implementation worker (multi-file features, UI/API/logic). Report:
  `docs/ai/50_worker_antigravity_report.md`.
- **Codex CLI** — debug/verification worker (lint/typecheck/test, Playwright, root-cause, minimal
  fixes). Report: `docs/ai/60_worker_codex_report.md`.
- A dispatched Claude worker reports to `docs/ai/55_worker_claude_report.md`.

---

## Worker Dispatch — always go through `scripts/ai/run_worker.sh` (SOT-1459)

**MANDATORY:** Claude Code must NEVER call `run_codex.sh`, `run_antigravity.sh`, or a nested `claude`
directly for role work. **AI does not call AI** — the dispatcher `run_worker.sh <role>` is the single
entry point for all delegated work.

How it works:
1. Write the role's worker-agnostic instruction to `prompts/roles/<role>.md` (see `TEMPLATE.md`).
2. Run `scripts/ai/run_worker.sh <role>` (set `TARGET_REPO=…` first when working a target repo).
3. The dispatcher reads the role's ordered chain from `config/worker_roles.json`, copies your prompt
   into the picked worker, and tries each worker in order:
   - on **non-response / usage-limit** (exit `75`) it hands off to the next worker, passing the partial
     report so work CONTINUES;
   - on first success (exit `0`) it stops and prints
     `WORKER_DISPATCH_DONE role=<role> worker=<w> report=<path>` — read that report;
   - if every worker is non-responsive it prints `WORKER_DISPATCH_EXHAUSTED`, exits `75`, and Claude
     Code takes over per the Fallback Policy.
4. Consecutive calls to the same worker reuse its session to keep the prompt cache warm (claude
   `--session-id`/`--resume`, codex `exec resume --last`, antigravity `--continue`; disable with
   `WORKER_SESSION_REUSE=0`).

The canonical role instruction lives in `prompts/roles/<role>.md`; the dispatcher writes it into the
per-worker files (`prompts/antigravity/implement.md`, `prompts/codex/debug.md`, `prompts/claude/worker.md`).

### Script-driven pipeline (default; SOT-1459)

For any targeted issue (`runner.ts` always injects `WEBHOOK_ISSUE_ID`), **`run_auto.sh` sequences the
whole lifecycle** by running `run_worker.sh <role>` in order:
**task-check → implementation → verification → acceptance → github → linear-report**.
**SOT-1553:** `task-check` and `decomposition` are no longer split across separate worker dispatches —
the single `task-check` role performs the actionability check AND the decomposition judgment (incl.
child-issue registration, inheriting the parent's Project/Priority) in one worker run, with no script in
between. The `decomposition` role stays valid for manual/override dispatch but is not a separate step in
the default pipeline. The roles read `docs/ai/pipeline/context.md` for the issue id / target repo. After
each role, `run_auto.sh` reads the winning report's `## Next Action` and gates:
- `task-check` not-actionable OR decomposed-into-children (`NEEDS_USER_INPUT`/`BLOCKED`) → stop as a
  successful no-op (exit 0);
- `verification`/`acceptance` `NEEDS_DEBUG` → loop back to `implementation` (bounded by
  `PIPELINE_MAX_DEBUG_CYCLES`, default 2);
- any `BLOCKED`/`NEEDS_USER_INPUT` or `WORKER_DISPATCH_EXHAUSTED` → stop (exit `70`, needs human);
- all roles `READY_FOR_REVIEW` → complete (exit 0).

A dispatched Claude worker gets a hard preamble constraining it to its single role for the single
target issue, forbidding it from launching `run_auto.sh` / `run_worker.sh` / the scheduler or
processing other issues. Escape hatch: `PIPELINE_MODE=0` (or a run with no issue id) falls back to the
legacy single Claude-orchestrator launch, which still routes each role through the dispatcher.

### Per-issue worker override from Linear (SOT-1459)

A human can reroute a role for **one issue** by writing a directive line in the issue description or a
comment:

```
workers: implementation=codex, verification=claude
```

- Each `role=chain` pair overrides that role for this issue's pipeline only; unmentioned roles keep the
  config default. Roles: `task-check`, `decomposition`, `implementation`, `verification`, `acceptance`,
  `github`, `linear-report`. Workers: `claude`, `codex`, `antigravity` (alias `agy`).
- Fallbacks use `>` (or `|` / `/`): `implementation=codex>claude`.
- The directive may appear in the description or any comment; the **newest occurrence wins** per role.
- Mechanics: at pipeline start `run_auto.sh` calls `runner-cli resolve-worker-roles <issue>`, which
  merges overrides onto the base config, writes `docs/ai/pipeline/worker_roles.<issue>.json`, and exports
  `WORKER_ROLES_FILE`. Fail-open: no directive / fetch error → default config. Parser:
  `src/lib/workerRoleDirective.ts`.

---

## Worker Non-Response Fallback Policy

- **"Non-response"** = ANY of: run script exits `75`; worker CLI exits non-zero (crash/auth/usage-limit);
  the invocation times out; or the report file is missing/empty/lacks a `## Next Action` line. Within a
  chain the dispatcher hands off per worker; only when the WHOLE chain is exhausted
  (`WORKER_DISPATCH_EXHAUSTED`, exit `75`) does Claude Code fall back.
- **Fallback rule.** Attempt normal delegation FIRST. Only on non-response may Claude Code take over that
  role directly, so the Issue is not blocked. This is a narrow, explicit exception to the delegation rules.
- **Bounded retry.** Retry a non-responsive worker AT MOST once before falling back. Never loop.
- **Quality unchanged.** All Quality Gates apply identically whether a worker or Claude Code did the work.
- **Disclosure.** On fallback, record (a) which worker failed, (b) the failure mode, (c) that Claude Code
  did the work — in the relevant worker report file (the audit sink). Do NOT post this to Linear; Linear
  gets only the work result.
- **Per-worker disable flags** (`CODEX_DISABLED` / `ANTIGRAVITY_DISABLED` / `CLAUDE_DISABLED`). A truthy
  value (`1|true|yes|on`) makes that worker's run script exit `75` so the dispatcher skips it. These are
  availability escape hatches evaluated *after* chain selection, not role overrides. Default off.
- The former global switches `ALL_CLAUDE_MODE` / `WORKER_MODE` were **removed**. Worker selection is
  governed solely by `config/worker_roles.json`.

### Per-role priority chains (`config/worker_roles.json`)

The single source of truth for which worker handles each role. Each role maps to an ordered chain
(index 0 = primary, rest = fallback order); a bare string is a single-element chain; keys starting with
`__` are docs. The dispatcher reads the chain, sets `RUN_WORKER_DISPATCH=1`, and tries workers in order.
**Precedence:** this config is evaluated *before* the per-worker availability flags and the usage-limit
cooldown. Fail-open: missing/invalid config or unknown role → dispatcher exits `75` (Claude fallback).
Helper: `src/lib/workerRoles.ts`. To run everything on Claude, set every role to `["claude"]`.

Default chains:

| Role | Default chain |
| --- | --- |
| `task-check` | `["codex","claude","antigravity"]` |
| `decomposition` | `["claude","codex","antigravity"]` |
| `implementation` | `["antigravity","codex","claude"]` |
| `verification` | `["codex","claude","antigravity"]` |
| `acceptance` | `["claude","codex","antigravity"]` |
| `github` (branch/PR/merge) | `["claude","codex","antigravity"]` |
| `linear-report` (state sync/progress) | `["claude","codex","antigravity"]` |

Every role — including Claude-primary ones — goes through the dispatcher; if Claude wins a chain,
`run_claude.sh` runs a dispatched Claude worker rather than the orchestrator acting inline.

---

## Instruction Prompt Templates

### Antigravity (`prompts/antigravity/implement.md`)

```
# Antigravity Worker Instruction
You are an implementation worker. You do NOT interact with the human directly.

## Context files to read first
- docs/ai/00_project_context.md, 10_plan.md, 20_design.md, 30_tasks.md, 40_acceptance.md

## Tasks
[Claude Code writes specific tasks here]

## Constraints
- Do not change the design without explicit instruction
- Do not refactor unrelated code
- Do not ask questions — use best judgment

## Output → docs/ai/50_worker_antigravity_report.md
# Worker Report
## Summary        <what was implemented>
## Changed Files  - `path` — change
## Commands Run   <shell commands>
## Acceptance Criteria  - [x]/[ ] with reason
## Risks          <risks, edge cases>
## Next Action    READY_FOR_REVIEW | NEEDS_DEBUG | NEEDS_USER_INPUT | BLOCKED
```

### Codex (`prompts/codex/debug.md`)

```
# Codex Worker Instruction
You are a debugging/verification worker. You do NOT interact with the human directly.

## Context files to read first
- docs/ai/00_project_context.md, 40_acceptance.md, 50_worker_antigravity_report.md

## Tasks
[Claude Code writes specific tasks here]

## Steps
1. Run lint / typecheck / test
2. Run Playwright e2e if applicable
3. Identify failures and apply minimal fixes only — do not refactor or change scope

## Output → docs/ai/60_worker_codex_report.md
# Worker Report
## Summary        <what was verified/fixed>
## Changed Files  - `path` — change (if any)
## Commands Run   <lint/test/typecheck results>
## Acceptance Criteria  - [x]/[ ] with reason
## Risks          <unresolved issues>
## Next Action    READY_FOR_REVIEW | NEEDS_DEBUG | NEEDS_USER_INPUT | BLOCKED
```

---

## Workflow

Autonomous (targeted issue), default:

```
Linear webhook / queue ─► runner.ts (injects WEBHOOK_ISSUE_ID) ─► run_auto.sh
  └─ for each role [task-check (incl. decomposition), implementation, verification, acceptance, github, linear-report]:
        run_worker.sh <role>  ─►  run_codex/claude/antigravity.sh (chain order; hand off on exit 75)
        ─► worker report ─► run_auto.sh gates on ## Next Action (proceed / loop / stop)
```

Legacy fallback (`PIPELINE_MODE=0`, or a manual run with no issue id): Claude Code orchestrator handles
requirements/plan/decomposition and routes each role through `run_worker.sh <role>`.

---

## Final Review Policy

Before reporting to the human, Claude Code must:
1. Read `docs/ai/50_worker_antigravity_report.md` — verify implementation completeness.
2. Read `docs/ai/60_worker_codex_report.md` — verify all checks pass.
3. Summarize in `docs/ai/70_final_report.md`.
4. If any critical issue remains, run another debug cycle before reporting.

---

## Safety Rules

- No destructive shell commands (`rm -rf`, `git reset --hard`, force push) without explicit approval.
- Do not modify `package.json`, `devcontainer.json`, or `.devcontainer/Dockerfile` unless explicitly asked.
- Do not delete existing files.
- Do not push to remote without explicit instruction.
- Do not mark a Linear Issue Done without verification; never hide failed tests or claim unverified completion.
- Do not expose internal worker prompts/reports to the human unless requested.
- All scripts run inside the Dev Container.

---

## Development Environment — Target Projects

When working a target project (e.g., booking-monitor):
1. **Clone to `/workspaces/<project>`** before starting (accessible inside the DevContainer, visible on
   host via bind mount). If it already exists, `git pull origin main`.
   `git clone https://github.com/sota1111/<project>.git /workspaces/<project>`.
2. **Workers must operate in `/workspaces/<project>`.** State the working dir at the top of worker
   instructions; set `TARGET_REPO=/workspaces/<project>`. Never use host OS paths — workers can't access them.
3. **Commit/push from the clone at `/workspaces/<project>`**, not from `/workspaces/ai-dev-control-plane`.

---

## Human Response Policy

- Reply in the same language the human used.
- Report only results, decisions, and next steps — not internal worker details.
- If a task can't be done safely, explain why and propose an alternative.
- Ask for clarification when requirements are ambiguous before implementing.

### Requirement Clarification (before starting; SOT-1421 / P4)

Terse one-line requirements are the biggest source of wasted work (same Issue reopened 2–5×). Before
implementing an ambiguous Issue, ONCE up front:
1. **State your interpretation** in a Linear comment (what it means, what you'll change).
2. **List the ambiguities** (assumptions, points that could mean more than one thing).
3. **Proceed or stop:** if there's one obviously-correct reading or a safe default, state it, proceed,
   and note it in the completion report. If interpretations genuinely diverge in a way that changes the
   deliverable, present the options, set the Issue to `In Review`, and stop for the human. Do NOT guess-and-reopen.
4. **Autonomous mode:** the note is a Linear comment. Never block waiting for a reply when a safe default
   exists — proceed on it and disclose.

Skip for Issues whose scope is already unambiguous.

---

## Linear Operating Policy

Linear is the external command/progress interface. The human uses it to check progress, add
instructions, change priorities, request debugging, review work, and approve/reject. Treat Linear
issues and comments as valid user instructions.

**Human interface:** the human communicates only through (1) direct Claude Code chat or (2) Linear
issue/comment. The human must never be asked to instruct a worker CLI directly.

**Claude's Linear responsibilities:** read relevant issues; understand the latest instruction; update
status; post progress comments; link notes to local files; decide worker internally; report results.

### Issue Types (title prefixes / labels)

`[PLAN]` design · `[IMPLEMENT]` implementation · `[DEBUG]` debugging · `[REVIEW]` review ·
`[URGENT]` priority · `[QUESTION]` clarification.

### Status Mapping

- **Backlog** — not yet processed by Claude.
- **Todo** — recognized, awaiting start.
- **In Progress** — Claude is working on it.
- **In Review** — implementation/verification done, awaiting human review; OR a PLAN task has produced
  its deliverable and stopped for human review/selection.
- **Blocked** — stopped on missing info, external factors, or awaiting approval.
- **Done** — complete and reported.

### Progress Comments

Post concise, structured comments at milestones (start, design done, implementation done, debug done,
blocked, done).

Progress format:
```markdown
## Progress Update
Status: In Progress
### Done / ### Current Work / ### Next / ### Blockers
```

Completion format:
```markdown
## Completion Report
Status: In Review
### Summary / ### Changed Files / ### Verification / ### Remaining Issues / ### Human Check Needed
```

### New Instructions From Linear

On a new comment: (1) read full context, (2) identify the latest instruction, (3) check whether it
changes scope/priority/acceptance, (4) update local planning files if needed, (5) continue or stop for
clarification. If it conflicts with prior scope, do NOT silently override — comment on the conflict and
proposed action.

### Worker Tool Use

**MANDATORY:** always delegate. All implementation → Antigravity; all verification/debug → Codex.
Claude Code must NEVER implement code or run tests directly, regardless of complexity — except under
the Fallback Policy. Do not expose the worker CLIs as user-facing agents in Linear; from the user's
view, Claude Code handles the task.

### Parallel Execution Policy (approved plan ①)

Claude's usage limit is **account-global** — parallelizing Claude's own compute just burns the shared
limit N× faster without raising throughput. Only parallelize wait/read-bound work that doesn't occupy
Claude's compute.

1. **Read-only investigation/verification may fan out in parallel (recommended).** Code investigation,
   acceptance checks, multi-repo live verification — fan out read-only sub-agents (`Agent` tool, e.g.
   `Explore` / `acceptance-checker` / `repo-scanner`) within one run. Sub-agents must do **no writes**
   (no implementation/git/PR); only conclusions return to the parent.
2. **Writes (implementation, git, PR) are single-lane.** Serial. Lane-parallelism is allowed only across
   **different repos**; the same repo/branch is always serial (avoid conflicts/corruption).
3. **Generation-heavy work (Claude-compute-bound)** stays single-lane — parallelizing only hits the
   global limit faster.

This doesn't conflict with the delegation flow: implementation stays with Antigravity, verification/fix
with Codex.

### Local Work Notes

Per issue, Claude may create `docs/ai/linear/<ISSUE_ID>.md` with: issue ID, title, URL, status, user
instructions, acceptance criteria, Claude's plan, Antigravity/Codex notes, verification result, final report.

### Linear Safety Rules

Do not: run destructive commands without approval; delete user files without approval; change unrelated
files; push without instruction; mark Done without verification; hide failed tests; claim completion
without verification. If verification can't be performed, state that clearly in the Linear comment.

---

## Child Issue Registration Policy

Claude judges whether to decompose a parent Issue into child Issues and handles registration. The
developer creates only the parent. Issues are NOT always decomposed — decompose only when complexity,
independence, verification unit, or PR-split necessity warrants it. Small tasks stay in the parent.

**Trigger (on a parent Issue):** (1) read description + comments, (2) identify acceptance criteria,
(3) judge whether to decompose, (4) if yes create 2–5 child Issues (up to 7 with justification) as
sub-issues, (5) if no process the parent directly.

**Decomposition judgment** — post in a Linear comment:
```
分解判断: 必要 / 不要
理由: <one-line reason>
```

**Decompose when:** multiple independent features/domains; different rollback/deploy/risk unit;
different review focus/file group; hard to track in one Issue; multiple PRs safer; work too large for
one run; sequential dependencies; criteria map to multiple deliverables.

**Do NOT decompose:** small README/doc edits; simple config additions; 1–2 file changes; clear approach
met in one PR; overhead > value; investigations/wording/comments/minor refactor; a single bug fix with
clear cause; a single feature whose impl+tests+docs belong together.

### Facet Issue Clustering (SOT-1421 / P8)

When many small related Issues accumulate for one feature area (they share a file group/component,
repeatedly reopen against each other, or their titles reference the same feature noun), prefer
clustering them as sub-issues under one parent (inherit Project/Priority) rather than leaving them
top-level. Do NOT over-cluster genuinely independent features. This is a triage-time organizing
judgment, not a reason to fabricate parent/child links.

### Child Issue Naming

Start the title with the feature/outcome, NOT a process name (avoid Implement/Debug/Test/Refactor or
`[IMPLEMENT]`/`[DEBUG]`/`[PLAN]` prefixes). E.g. "usage-limit後のresumeメタデータ保存を追加する".

### Child Issue Description Template

```markdown
## 目的            <feature change this Issue achieves>
## 変更範囲        - target files / components
## 実装内容        - what to implement
## 検証内容        - verification within this Issue (Debug/Test included here, not a separate Issue)
## 想定commit      - meaningful commit(s) this Issue maps to (≥1)
## 受け入れ条件    - [ ] completion condition verifiable standalone
## 関連する親Issue - parent Issue ID and Title
```

### Registration Procedure

Use `mcp__linear-server__create_issue`: (1) create child, (2) link via `parentId`, (3) Status `Todo`,
(4) inherit Priority from parent, (5) inherit Project (`project`/`projectId`), (6) comment the
decomposition result on the parent.

**Issue-cap recovery ("cannot add issue").** If `create_issue` fails because the workspace hit its
Issue cap (free plan = 250): (1) `bash scripts/ai/archive_linear_issues.sh --execute` to archive old
child Issues (keeps parent 150 / total 200), (2) retry the failed `create_issue` once, (3) if still
failing set the parent `Blocked` and comment the reason. `run_auto.sh` also runs a capacity preflight
at startup and auto-archives when total ≥ `ISSUE_CAP_TRIGGER` (default 245). See
`docs/linear-issue-archive.md`.

### Execution Order

Run feature Issues in dependency order. Per Issue: Claude (plan) → Antigravity (implement) → Codex
(test/verify). Set each to `Done` on completion, then the next. After all children, set the parent to
`In Review`.

### Local Tracking

After registration, create `docs/ai/linear/<PARENT_ISSUE_ID>.md` recording parent info and all child
Issues with progress.

---

## Issue Classification Policy

Before starting any Issue, classify it — this determines the worker and approach. Post the
classification as a Linear comment at the start:
```
タスク分類: <TYPE>
担当AI: <TYPE>:<WORKER>   (e.g. IMPLEMENT:ANTIGRAVITY)
```

| Type | Description | Primary Worker |
| --- | --- | --- |
| `PLAN` | Design, policy planning | Claude Code (structures plan; delegates impl to Antigravity) |
| `IMPLEMENT` | New/multi-file implementation | Antigravity (always delegate) |
| `FIX` | Small bug fix (clear single-file cause) | Codex |
| `DEBUG` | Test failures, error investigation | Codex |
| `DOC` | Documentation changes | Codex (small) / Antigravity (large) |
| `REVIEW` | PR diff / acceptance check | Codex (first pass) → Claude (final) |
| `SECURITY` | Permission/secret/env/devcontainer check | Codex (scan) → Claude (judge) |

**PLAN terminal state:** a PLAN task produces its deliverable, then stops at `In Review` for human
review — no PR/merge/`Done`. Implementation tasks (IMPLEMENT/FIX/DEBUG) go through PR→merge, then sit at
`In Review` (not auto-`Done`).

### Worker Failure Re-Delegation

Re-delegate rather than fixing directly: (1) Antigravity impl → test failure → Codex as `DEBUG`;
(2) Codex fix → spec mismatch → Antigravity as `IMPLEMENT`/`PLAN`; (3) 2+ consecutive failures → post
reason to Linear and set `Blocked`. Claude must NOT chase failures with manual debugging.

---

## GitHub Operations Policy

Claude Code owns all GitHub ops: branch, commit, PR create/update, merge. GitHub is the artifact/history
store.

**Branch:** `main` (protected) → `feat/<issue-id>-<short-description>` (lowercase alphanumeric + hyphen).
One feature branch per parent Issue; all child work on the same branch. Create at first child start:
```bash
git checkout main && git pull origin main && git checkout -b feat/<issue-id>-<short-description>
```

**Commit:** one or more meaningful commits per feature Issue (not one giant PR). Message:
`<type>(<issue-id>): <summary>` (e.g. `feat(LC-100): …`).

### PR Creation Gate (MANDATORY)

Always create a PR after all child Issues are Done. Pushing directly to `main` is prohibited.
**PLAN tasks are the exception — no PR; stop at `In Review`.** The gate below and merge steps apply only
to IMPLEMENT/FIX/DEBUG/DOC. Create a PR only when ALL hold:
1. All child Issues Done.
2. `npm run lint` exit 0.
3. `npm run typecheck` exit 0.
4. `npm test` exit 0.
5. `npm run e2e` exit 0 (if applicable).
6. `git diff main...HEAD` reviewed — no unintended changes.
7. Parent's acceptance criteria all met.

If any fails, don't create the PR — reopen the failed child and run the fix cycle.

### Bug-Label GitHub Issue

If the Linear Issue has a **`Bug` label**, also create a GitHub Issue and link it (auto-closes on merge).
Only for PR-producing tasks (not PLAN); one GitHub Issue per parent Linear Issue; do it after the gate,
just before PR creation.
```bash
gh issue create --title "<Linear Title>" --body "<desc + criteria + Linear URL + ID>" --label bug
```
Add `--label bug` only if the repo has that label. Put `Closes #<N>` in the PR body. Record the GitHub
Issue URL on the Linear Issue. Best-effort: if it fails, comment on Linear and proceed with the PR/merge.

### Snapshot-Label Screenshot

If the Linear Issue has a **`snapshot` label**, capture an **after** screenshot and attach it to both the
PR and the Linear Issue. Only for PR-producing tasks; after the gate, before PR creation.
1. **Capture** via the project's existing e2e/Playwright mock harness (`installApiMocks`/`login`); commit
   the image (e.g. `docs/screenshots/`) and note the commit SHA. Skip for changes with no visible screen
   (backend/doc only) and note that on Linear.
2. **PR:** embed via the commit-SHA permanent URL —
   `![after](https://raw.githubusercontent.com/<owner>/<repo>/<sha>/docs/screenshots/<file>)`.
3. **Linear:** `prepare_attachment_upload` → `curl -X PUT` the signed URL (headers verbatim, within 60s)
   → `create_attachment_from_upload`; inline the `uploads.linear.app` URL as `![after](...)` in a comment.

Best-effort: on failure, comment on Linear and proceed.

### PR Creation

```bash
git push origin feat/<issue-id>-<short-description>
```
Create via MCP or `gh`. Title `feat(<issue-id>): <parent Title>`; base `main`; body per template below.
After creation: comment the PR link on the parent and set it to `In Progress`.

PR body template:
```markdown
## Summary        <parent goal, 1–2 sentences>
## Changes        - <bullets>
## Related Issues  - Parent: <ID>  - Children: <IDs>  - Closes #<N>  <!-- Bug label only -->
## Quality Gate Results
- [x] Lint / TypeCheck / Unit Test / E2E (pass or N/A) / Diff Review
## Snapshot       <!-- snapshot label only -->
![after](https://raw.githubusercontent.com/<owner>/<repo>/<sha>/docs/screenshots/<file>)
## Acceptance Criteria  - [x] <criterion>
```

### Merge

Merge when: PR created and gate passed; no conflict with `main`. If so, Claude merges autonomously
(no separate approve, no waiting on the developer):
```bash
gh pr merge <PR> --merge --delete-branch
git -C <repo-path> pull origin main
```
After merge: set the parent to `In Review` (awaiting human review — never auto-`Done`); comment the
Completion Report; delete the feature branch. **Auto-redeploy (best-effort, SOT-1421 / P6):** call
`scripts/ai/redeploy_after_merge.sh <repo-or-project> [localPath]`. Default off (runs only when
`REDEPLOY_ENABLED` is truthy); command from `REDEPLOY_CMD` or `config/deploy_commands.json`. Always
exits 0 (best-effort). Enable only where credentials exist; log failures to Linear.

**Merge conflict:** `git merge --abort` → try `git rebase main` on the feature branch → if unresolved,
set the parent `Blocked` and comment the conflict.

---

## GitHub → Linear State Sync

After a GitHub event, sync state to Linear (the only report channel — no other route).

| GitHub Event | Linear Action |
| --- | --- |
| Branch created | Parent: "branch created" comment |
| PR created | Parent → `In Progress`, PR-link comment |
| PR updated (push) | Parent: diff-summary comment |
| PR merged | Parent → `In Review`, Completion Report comment |
| PR closed (not merged) | Parent → `Blocked`, reason comment |

Sync comment format:
```markdown
## GitHub Sync
Event: <PR Created / PR Merged / Branch Created>
### Details   - Branch / PR #<n> (URL) / Status
### Next Action  - <confirmation request or completion report>
```

**Autonomous mode reporting:** Linear comments are the ONLY report channel — no chat/email/Slack.

---

## Quality Gate Criteria

**PR gate:** Q1 lint 0 (`npm run lint`) · Q2 typecheck 0 (`npm run typecheck`) · Q3 unit tests pass
(`npm test`) · Q4 e2e pass (`npm run e2e`, when applicable) · Q5 no unintended diff · Q6 acceptance met
· Q7 all child Issues Done.

**Merge gate:** M1 PR gate (Q1–Q7) passed · M2 no conflict with `main` (`git merge --no-commit` test).

**On failure:** (1) identify the failed item, (2) reopen/create the child Issue, (3) Antigravity fixes →
Codex re-verifies, (4) repeat until all pass, (5) after 3 consecutive failures set the parent `Blocked`
and comment the cause.
