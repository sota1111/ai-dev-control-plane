## Authentication Assumptions

The following authentication commands (from README) are assumed to have been completed on this machine. Do NOT attempt to re-authenticate.

- Linear MCP: configured via `claude → /mcp → linear`
- Gemini CLI: authenticated via `gemini`
- Codex CLI: authenticated via `codex`, Linear MCP via `codex mcp login linear`
- GitHub CLI: authenticated via `gh auth login`
- Azure CLI: authenticated via `az login --use-device-code`
- gcloud: authenticated via `gcloud auth login` and `gcloud auth application-default login`

---

Please process Linear issues using the following procedure.

Use the MCP tool `mcp__linear-server__list_issues` to retrieve issues.

Target the following statuses:

- Backlog
- Todo
- In Progress
- Blocked (only if the blocking factor can be resolved)

Sort the issues by priority in the following order:

Urgent → High → Medium → Low

Within the same priority, process them in the following status order:

In Progress → Todo → Backlog

---

## Work Start Pre-Processing

**IMPORTANT: Perform these steps for each selected issue BEFORE any classification or analysis.**

When you have selected the highest-priority issue to process, execute the following steps first:

### Step 1: Update Linear status to In Progress

Check the issue's current `status` field from the retrieved issue data:

- If status is `Todo`: call `mcp__linear-server__save_issue` with `id: <issue-id>` and `state: "In Progress"`
- If status is already `In Progress` or any other value: skip — do not make an unnecessary update
- On success: output `[PRE] <issue-id> status: <old_status> → In Progress (<UTC datetime>)`
- On skip: output `[PRE] <issue-id> status already In Progress, skipped`
- On failure: output `[PRE] <issue-id> status update FAILED: <reason>` and continue (do not abort)

### Step 2: Remove usage-limit label (if present)

Check whether the issue has a label named `usage-limit` in its labels list:

- If `usage-limit` label is present: call `mcp__linear-server__save_issue` with `id: <issue-id>` and `labels` set to the issue's current labels list **minus** the `usage-limit` entry (keep all other labels)
- If `usage-limit` label is NOT present: skip
- On success: output `[PRE] <issue-id> usage-limit label: found and removed`
- On skip: output `[PRE] <issue-id> usage-limit label: not present, skipped`
- On failure: output `[PRE] <issue-id> usage-limit removal FAILED: <reason>` and continue (do not abort)

### Step 3: Proceed

Only after completing Steps 1 and 2 (or confirming they are not needed), proceed to Issue Classification below.

---

## Issue Classification

Before starting work on any Issue, classify it and post the classification as a Linear comment:

```
タスク分類: PLAN | IMPLEMENT | FIX | DEBUG | DOC | REVIEW | SECURITY
推奨worker: gemini | codex | claude-code
理由: <one-line reason>
```

**Task types:**
- `PLAN`: Design, policy planning
- `IMPLEMENT`: New implementation, multi-file changes
- `FIX`: Small bug fixes (1–2 files, clear cause)
- `DEBUG`: Test failures, error investigation
- `DOC`: Documentation only (README, CLAUDE.md, prompts, .env.example)
- `REVIEW`: PR diff review, acceptance criteria check
- `SECURITY`: Permission, secret, devcontainer, env var check

**Worker selection:**
- `PLAN` → Claude Code plans; delegate to Gemini CLI if needed
- `IMPLEMENT` → Gemini CLI
- `FIX` → Codex CLI
- `DEBUG` → Codex CLI
- `DOC` → Codex CLI (small edit) or Gemini CLI (large rewrite)
- `REVIEW` → Codex CLI first pass, then Claude Code final judgment
- `SECURITY` → Codex CLI static check, then Claude Code final judgment

**Worker failure re-delegation:**
- Gemini implementation → test failure: re-delegate to Codex CLI as `DEBUG`
- Codex fix → specification mismatch: re-delegate to Gemini CLI as `IMPLEMENT` or `PLAN`
- 2+ consecutive failures: set Issue to `Blocked`, post reason to Linear

---

## Parent Issue Detection and Child Issue Decomposition

When you find an issue that has NO sub-issues and contains a high-level requirement (parent Issue):

### Step 1: Judge whether decomposition is necessary

Read the parent Issue description and all comments, then decide:

**Decompose into child Issues when:**
- Multiple independent features or domains are involved
- Work types are clearly separated (implementation, testing, docs, config)
- Work volume is large; one auto-run session is unlikely to complete it
- Tasks have sequential dependencies
- Separate Gemini/Codex delegation units would be clearer
- Acceptance criteria map to multiple independent deliverables

**Do NOT decompose (handle parent Issue directly) when:**
- Small README or documentation edits
- Simple config file additions (e.g., `.env.example`)
- Minor changes limited to 1–2 files
- Implementation approach is clear and acceptance criteria can be met in one PR
- Creating child Issues adds more overhead than value
- Investigations, wording fixes, or single bug fixes with clear fix location

Post your judgment as a Linear comment on the parent Issue:

```
分解判断: 必要 / 不要
理由: <one-line reason>
```

### Step 2a: If decomposition IS needed

1. Decompose into child Issues (minimum necessary, typically 2–5; maximum 7 with clear justification)
2. Use `mcp__linear-server__save_issue` to register each child Issue with:
   - parentId: the parent Issue ID
   - Title format: `[IMPLEMENT] <parent-id> - <task name>` or `[DEBUG] <parent-id> - <verification>`
   - Description: Goal, Scope, Acceptance Criteria, Dependencies
   - Status: Todo
   - Priority: inherit from parent
3. Post a summary comment on the parent Issue listing all created child Issues
4. Create local tracking file: `docs/ai/linear/<PARENT_ISSUE_ID>.md`
5. Execute child Issues in order: [PLAN] → [IMPLEMENT] → [DEBUG]

### Step 2b: If decomposition is NOT needed

1. Mark the parent Issue as `In Progress`
2. Post a progress comment including the decomposition judgment
3. Write Gemini or Codex instruction as appropriate for the task type
4. Run the worker
5. Commit, run quality gate, create PR, merge
6. Mark parent Issue as `Done` and post Completion Report

---

## Child Issue Execution Loop

For each child Issue (in order: [PLAN] → [IMPLEMENT] → [DEBUG]):

1. Update child Issue status to `In Progress`
2. Post a progress comment on the child Issue

### For [PLAN] child Issues:

- Write design to `docs/ai/20_design.md`
- Mark child Issue as `Done`

### For [IMPLEMENT] child Issues:

- Write Gemini instruction to `prompts/gemini/implement.md`
- Run `scripts/ai/run_gemini.sh`
- Read `docs/ai/50_worker_gemini_report.md`
- Commit changes: `git add -A && git commit -m "feat(<parent-id>): <summary>"`
- Mark child Issue as `Done`

### For [DEBUG] child Issues:

- Write Codex instruction to `prompts/codex/debug.md`
- Run `scripts/ai/run_codex.sh`
- Read `docs/ai/60_worker_codex_report.md`
- If fixes were applied, commit: `git add -A && git commit -m "fix(<parent-id>): <summary>"`
- Mark child Issue as `Done`

---

## Branch Management

Before starting the first child Issue of a parent:

```bash
git checkout main
git pull origin main
git checkout -b feat/<issue-id>-<short-description>
```

All child Issue work happens on this branch.

---

## Quality Gate and PR Creation

After ALL child Issues are Done:

1. Run quality checks:
   - `npm run lint` → must exit 0
   - `npm run typecheck` → must exit 0
   - `npm test` → must exit 0
   - `npm run e2e` → must exit 0 (if applicable)
2. Review diff: `git diff main...HEAD` — no unintended changes
3. Verify all acceptance criteria from parent Issue are met

If ALL pass:

- `git push origin feat/<issue-id>-<short-description>`
- Create PR via GitHub CLI or MCP tool
- Post PR link as comment on parent Issue
- Update parent Issue status to `In Review`

Then immediately merge the PR:

```bash
gh pr merge <PR_NUMBER> --merge --delete-branch
```

After merge:

- Pull latest main: `git -C <repo-path> pull origin main`
- Update parent Issue status to `Done`
- Post Completion Report comment on parent Issue (summary, changed files, verification results)

If ANY quality check fails:

- Identify failing item
- Create or reopen a [DEBUG] child Issue
- Re-run the fix cycle
- If 3 consecutive failures, set parent Issue to `Blocked` with explanation

If merge has conflicts:

1. `git merge --abort`
2. Attempt `git rebase main` on the feature branch
3. If unresolvable, set parent Issue to `Blocked` with conflict details

---

## Permission Error Handling

If you encounter a permission error, authentication failure, or insufficient credentials while working on a task:

1. **Do NOT retry** the failing operation
2. **Change the task's Linear status to `In Review`** (not Blocked):
   ```
   mcp__linear-server__save_issue: state = "In Review"
   ```
3. **Post a comment on the Linear issue** in this format:
   ```
   ## 権限不足による一時停止

   ### 必要な権限
   - <specific permission, role, or credential that is missing>

   ### 試みた操作
   - <what was attempted that failed>

   ### 再開条件
   必要な権限を取得後、このIssueをTodo/In Progressに戻して再実行してください。
   ```
4. **Move on to the next actionable issue** in the priority queue
5. **Do NOT** set the issue to `Blocked` — use `In Review` for permission-related holds

Examples of permission errors that trigger this protocol:
- `ERROR: (gcloud.run.deploy) PERMISSION_DENIED`
- `Error: You do not have permission to...`
- `403 Forbidden` when accessing GCP, GitHub, or other external services
- Missing API keys or credentials for external services

---

## Termination Conditions

Terminate when ANY of the following is true:

- All child Issues are Done, PR is merged, and parent Issue is set to `Done`
- A blocking condition cannot be resolved (parent set to Blocked with explanation)
- No actionable issues remain in Linear
- Continuing further will not produce new results

Prohibited:

- Waiting for interaction
- Waiting for additional instructions
- Infinite loops
- Waiting for confirmation to continue

When completed or failed, output a brief final result and terminate with `exit 0` or `exit 1`.
