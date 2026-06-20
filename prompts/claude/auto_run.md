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

## Agent Responsibility Boundary

- Initial task check / タスク確認 is handled by Codex CLI.
  - Write the task-check instruction to `prompts/codex/debug.md`.
  - Run `scripts/ai/run_codex.sh` once for the selected issue.
  - Read `docs/ai/60_worker_codex_report.md` before proceeding.
- Claude Code takes over from decomposition onward: decomposition judgment, child Issue creation, worker delegation, Linear status sync, PR flow, and final reporting.
- Do not repeat the task check for the same issue within one run.

---

## Parallel Execution Policy

承認済みの並列化方針（案①）。Claude 利用上限は **account-global**（アカウント全体で共有）のため、
並列化の効果が出るのは「**Claude を専有しない並列**」だけ、という前提を固定する。
Claude 自身の計算を並列に増やしても、同じ上限を N 倍速で食い潰すだけでスループットは上がらない。

1. **read-only な調査・検証は並列 fan-out 可（推奨）**
   - 対象: コード調査・受入チェック・複数 repo の live 検証など、読取り/待ち主体の作業。
   - 方法: 1 run 内で sub-agent（`Agent` tool, 例: `Explore` / `acceptance-checker` / `repo-scanner`）に
     read-only で並列 fan-out し、結論のみ親に集約する。sub-agent に書き込みはさせない。
2. **書き込み（実装・git・PR）は単線**
   - 実装/commit/branch/PR は直列。**別 repo の時だけ lane 並列可**。同一 repo / 同一 branch は必ず直列。
3. **生成量が多い作業（Claude 計算主体）は単線で受容**
   - 大量のコード/長文生成は並列化しても上限に N 倍速で当たるだけなので単線で受容する。

この方針は既存の委譲フロー（Gemini=実装 / Codex=検証）と矛盾しない。read-only fan-out は
Claude Code の調査・検証の補助であり、実装は Gemini、検証/修正は Codex への委譲を維持する。

### lane 並行 / デタッチ実行モデル（案② / SOT-911）

書き込み（実装・git・PR）の並列は「別 repo の時だけ lane 並行可」。これを支える実行基盤:

- **lane 分離**: `RUNNER_LANE` で lock / queue / ワーカー成果物を lane 別パスにし、別 repo の
  ドレインを独立 lane で並行できる。default lane は従来パス（後方互換）。**同一 repo / 同一 branch は必ず直列**。
- **デタッチ実行**: Linear `long-run` ラベルの Issue は切り離し起動され、JS ロックを即解放する。
  完了は done-marker 経由で reaper（`reapCompletedDetachedRuns`）が後処理し、成功クリーンアップ /
  usage-limit resume 再投入 / 失敗ログを共通の `processCompletedRun` で行う。
- **可視化**: lane / デタッチ実行の起動・完了（成功 / 未検証 / usage-limit / 失敗）は Discord に通知される。
- 詳細仕様は `docs/runner-queue.md`「lane 並行 / デタッチ実行モデル」を参照。

---

Use the MCP tool `mcp__linear-server__list_issues` to retrieve issues.

Target the following statuses:

- Todo
- In Progress
- Blocked (only if the blocking factor can be resolved)

Do NOT process `Backlog` issues. Backlog issues are not yet triaged for automated
work; leave them untouched until a human moves them to `Todo`.

Sort the issues by priority in the following order:

Urgent → High → Medium → Low

Within the same priority, process them in the following status order:

In Progress → Todo

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
担当AI: <TYPE>:<WORKER>   （例: IMPLEMENT:GEMINI / DOC:CLAUDE-CODE）
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

**PLAN task terminal state (重要):**
- `PLAN` タスクは成果物（方針・一覧・設計メモ等）を作成したら、PR作成・merge・`Done` には進めない。
- 成果物を提示したうえで対象Issueを **`In Review`** に設定し、人間のレビュー/選択を待って停止する。
- PLANの成果物は Linear コメント、および必要に応じて `docs/ai/10_plan.md` / `docs/ai/20_design.md` に記録する。
- IMPLEMENT / FIX / DEBUG など実装系タスクは従来どおり PR → merge → `Done` に進める（この例外の対象外）。

---

## Parent Issue Detection and Child Issue Decomposition

When you find an issue that has NO sub-issues and contains a high-level requirement (parent Issue):

### Step 1: Judge whether decomposition is necessary

Read the parent Issue description and all comments, then decide:

**Decompose into child Issues when (by feature / commit unit):**
- Multiple independent features or domains are involved
- A change is a different rollback unit, deploy impact, or risk level
- A change has a significantly different review focus or touches a different responsibility / file group
- Work volume is large; one auto-run session is unlikely to complete it
- Acceptance criteria map to multiple independent feature deliverables

Do NOT decompose by work phase. Never create Debug-only / Implement-only / Test-only child Issues; each child Issue is one feature/commit unit that includes its own implementation, tests, and doc updates.

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
   - Title: start with the feature/outcome (例: `queueのdequeue順をLinear priority準拠にする`). Do NOT use process prefixes ([IMPLEMENT]/[DEBUG]/[PLAN]/Debug:/Implement:/Test:/Refactor:).
   - Description (child Issue body template): 目的 / 変更範囲 / 実装内容 / 検証内容（Debug・Testはここに含める） / 想定commit / 受け入れ条件 / 関連する親Issue
   - Status: Todo
   - Priority: inherit from parent
3. Post a summary comment on the parent Issue listing all created child Issues
4. Create local tracking file: `docs/ai/linear/<PARENT_ISSUE_ID>.md`
5. Execute child (feature) Issues in dependency order. Within each feature Issue, run the worker steps in order: Claude（方針整理）→ Gemini（実装）→ Codex（テスト・不具合確認）.

### Step 2b: If decomposition is NOT needed

1. Mark the parent Issue as `In Progress`
2. Post a progress comment including the decomposition judgment
3. Branch by task type:
   - **PLAN task**: write the planning artifact (方針・一覧・設計メモ) to the Linear issue (and `docs/ai/10_plan.md` / `docs/ai/20_design.md` if substantial). Do NOT create a PR, do NOT merge, do NOT set `Done`. Set the Issue to `In Review` and stop, awaiting human selection. Skip the Quality Gate and PR Creation section.
   - **Implementation task (IMPLEMENT / FIX / DEBUG / DOC)**:
     1. Write Gemini or Codex instruction as appropriate for the task type
     2. Run the worker
     3. Commit, run quality gate, create PR, merge
     4. Mark parent Issue as `Done` and post Completion Report

---

## Child Issue Execution Loop

For each child (feature/commit) Issue, in dependency order:

1. Update child Issue status to `In Progress`
2. Post a progress comment on the child Issue
3. Claude Code: confirm scope/approach for this feature (write design notes to `docs/ai/20_design.md` only if non-trivial)
4. Implementation (Gemini): write `prompts/gemini/implement.md`, run `scripts/ai/run_gemini.sh`, read `docs/ai/50_worker_gemini_report.md`
5. Verification (Codex): write `prompts/codex/debug.md`, run `scripts/ai/run_codex.sh`, read `docs/ai/60_worker_codex_report.md`; if fixes were applied they are part of this same feature Issue
6. Commit the feature: `git add -A && git commit -m "feat(<parent-id>): <feature summary>"` (1+ meaningful commits for this Issue)
7. Mark the child Issue as `Done`

Note: Debug and Test are NOT separate child Issues — they are the verification step (step 5) inside each feature Issue. Claude Code must still delegate all implementation to Gemini and all verification/fixes to Codex.

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

> **Scope note:** This section applies to implementation-producing tasks (IMPLEMENT / FIX / DEBUG / DOC).
> **PLAN tasks do NOT enter this section** — they stop at `In Review` after producing their planning
> artifact (see the PLAN terminal-state rule in Issue Classification). Do not create a PR, merge, or set
> `Done` for a PLAN task.

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
- Reopen the relevant feature/commit Issue (or add verification work to it) and re-run Gemini→Codex inside it
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
- A PLAN task has produced its planning artifact and the Issue is set to `In Review` (no PR/merge/Done expected for PLAN)
- A blocking condition cannot be resolved (parent set to Blocked with explanation)
- No actionable issues remain in Linear
- Continuing further will not produce new results

Prohibited:

- Waiting for interaction
- Waiting for additional instructions
- Infinite loops
- Waiting for confirmation to continue

When completed or failed, output a brief final result and terminate with `exit 0` or `exit 1`.
