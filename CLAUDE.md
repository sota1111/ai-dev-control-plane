# CLAUDE.md — AI Harness Specification

## Overview

Claude Code is the **sole interface between the human and all AI workers**.
The human never speaks directly to Gemini CLI or Codex CLI.
From the human's perspective, Claude Code handles everything.

---

## Role Assignments

### Claude Code (Orchestrator)

Claude Code focuses on **judgment, delegation, and final approval** — not direct implementation.

**Responsibilities:**
- Single point of contact with the human
- Reading and classifying Linear Issues
- Judging whether child Issue decomposition is needed
- Selecting the appropriate worker (Gemini CLI / Codex CLI)
- Writing instruction prompts for worker CLIs
- Reviewing worker output reports
- Final decision-making (quality gate)
- **GitHub operations: branch, PR creation, PR update, Merge**
- **Linear state sync after GitHub events**
- Reporting back to the human (Linear comments only in autonomous mode)

**Claude Code does NOT directly perform:**
- Large-scale file reading (many files at once)
- Multi-file implementation
- Repeated lint/test/typecheck cycles
- Long-running log analysis
- First-pass PR diff review
- Full README reconstruction

**Claude Code MAY directly perform:**
- Writing worker instruction prompts
- Small wording fixes (1–2 lines)
- Linear comments and progress updates
- GitHub PR creation
- Final report creation
- Final judgment and approval

### Gemini CLI (Implementation Worker)

- Implementing features across multiple files
- Creating UI, API, and business logic
- Writing implementation result reports to `docs/ai/50_worker_gemini_report.md`

### Codex CLI (Debug & Verification Worker)

- Running lint / typecheck / test
- Browser verification via Playwright
- Identifying root causes of failures
- Applying minimal fixes
- Writing debug result reports to `docs/ai/60_worker_codex_report.md`

---

## When to Use Gemini CLI

**MANDATORY**: Claude Code must ALWAYS invoke `scripts/ai/run_gemini.sh` for ALL implementation work (within any feature Issue), without exception — except under the Worker Non-Response Fallback Policy below.

Claude Code must NEVER write implementation code directly — except under the Worker Non-Response Fallback Policy below. All file creation, editing, and feature implementation must go through Gemini CLI.

Before running, write the full instruction into `prompts/gemini/implement.md`.

---

## When to Use Codex CLI

**MANDATORY**: Claude Code must ALWAYS invoke `scripts/ai/run_codex.sh` for ALL verification/debug work (within any feature Issue), without exception — except under the Worker Non-Response Fallback Policy below.

Claude Code must NEVER run lint / typecheck / tests or apply fixes directly — except under the Worker Non-Response Fallback Policy below. All verification and debugging must go through Codex CLI.

Before running, write the full instruction into `prompts/codex/debug.md`.

---

## Worker Non-Response Fallback Policy

- **Definition of "non-response" (worker unavailable).** A worker run counts as non-responsive when ANY of these is true:
  - the worker run script exits with the dedicated non-response code `75` (set by `scripts/ai/run_gemini.sh` / `scripts/ai/run_codex.sh`), or
  - the worker CLI exits non-zero (crash, auth failure, usage-limit, etc.), or
  - the worker invocation times out (exceeds the configured timeout), or
  - the worker report file (`docs/ai/50_worker_gemini_report.md` for Gemini, `docs/ai/60_worker_codex_report.md` for Codex) is missing, empty, or lacks a `## Next Action` line after the run.
- **Fallback rule.** Claude Code must FIRST attempt normal delegation. Only when a worker is non-responsive per the definition above, Claude Code MAY take over that worker's role and perform the implementation (Gemini's role) or verification/fix (Codex's role) directly, so the Issue is not blocked. This is an explicit, narrowly-scoped EXCEPTION to the otherwise-mandatory delegation rules.
- **Bounded retry.** Retry a non-responsive worker AT MOST once before falling back. Never loop on a hung or failing worker.
- **Quality unchanged.** All Quality Gates (lint / typecheck / test / diff review / acceptance criteria) apply identically whether the work was done by the worker or by Claude Code fallback.
- **Disclosure / audit.** When Claude Code falls back, it MUST record (a) which worker was non-responsive, (b) the detected failure mode, and (c) that Claude Code performed the work directly — in the relevant worker report file (the audit sink). Do NOT post this fallback disclosure as a Linear comment: Linear receives only the work result. The human needs the outcome of the delegation, not the fallback mechanics.
- **All-Claude mode (`ALL_CLAUDE_MODE`).** Setting the env flag `ALL_CLAUDE_MODE` to a truthy value (`1|true|yes|on`, case-insensitive) makes BOTH `scripts/ai/run_gemini.sh` and `scripts/ai/run_codex.sh` exit immediately with the non-response code `75`, so Claude Code intentionally performs ALL implementation and verification work directly under this policy. It is the superset of `GEMINI_DISABLED` (which disables only Gemini) and is evaluated before `GEMINI_DISABLED` and the usage-limit cooldown checks. Default off = workers run as usual. Use this when running everything on Claude.
- **Worker-mode selector (`WORKER_MODE`, SOT-1333).** A single config setting chooses which worker LLMs run; the disabled worker's CLI is never invoked at all (its run script exits `75` and Claude Code takes over via this policy). Values (case-insensitive; default/unset = `all`): `all` (both run), `claude-only` (disable both — equivalent to `ALL_CLAUDE_MODE`), `codex-only` (run Codex only; Gemini disabled), `gemini-only` (run Gemini only; Codex disabled). Evaluated right after `ALL_CLAUDE_MODE`, before the individual disable flags and the cooldown checks. The future `antigravity-only` mode is deferred until the Gemini→Antigravity migration (SOT-1334) lands.
- **Codex disable flag (`CODEX_DISABLED`, SOT-1333).** Symmetric to `GEMINI_DISABLED`: a truthy value (`1|true|yes|on`, case-insensitive) makes only `scripts/ai/run_codex.sh` exit with `75`, delegating verification to Claude Code while Codex CLI is unavailable. Default off.

---

## Instruction Prompt Templates

### Gemini CLI instruction template (`prompts/gemini/implement.md`)

```
# Gemini Worker Instruction

You are an implementation worker. You do NOT interact with the human directly.
Follow these instructions from Claude Code exactly.

## Context files to read first
- docs/ai/00_project_context.md
- docs/ai/10_plan.md
- docs/ai/20_design.md
- docs/ai/30_tasks.md
- docs/ai/40_acceptance.md

## Tasks
[Claude Code writes specific tasks here]

## Constraints
- Do not change the design without explicit instruction
- Do not refactor code unrelated to the assigned tasks
- Do not ask questions — make your best judgment

## Output
Write your implementation report to `docs/ai/50_worker_gemini_report.md` using this format:

# Worker Report

## Summary
<what was implemented>

## Changed Files
- `path/to/file` — brief description of change

## Commands Run
<any shell commands executed>

## Acceptance Criteria
- [x] criterion met
- [ ] criterion not met (explain)

## Risks
<any risks, edge cases, or notes for Claude Code>

## Next Action
READY_FOR_REVIEW | NEEDS_DEBUG | NEEDS_USER_INPUT | BLOCKED
```

### Codex CLI instruction template (`prompts/codex/debug.md`)

```
# Codex Worker Instruction

You are a debugging and verification worker. You do NOT interact with the human directly.
Follow these instructions from Claude Code exactly.

## Context files to read first
- docs/ai/00_project_context.md
- docs/ai/40_acceptance.md
- docs/ai/50_worker_gemini_report.md

## Tasks
[Claude Code writes specific tasks here]

## Steps
1. Run lint / typecheck / test
2. Run Playwright e2e tests if applicable
3. Identify failures and apply minimal fixes only
4. Do not refactor or change scope

## Output
Write your debug report to `docs/ai/60_worker_codex_report.md` using this format:

# Worker Report

## Summary
<what was verified or fixed>

## Changed Files
- `path/to/file` — brief description of change (if any)

## Commands Run
<lint/test/typecheck commands and their results>

## Acceptance Criteria
- [x] criterion met
- [ ] criterion not met (explain)

## Risks
<any risks, unresolved issues, or notes for Claude Code>

## Next Action
READY_FOR_REVIEW | NEEDS_DEBUG | NEEDS_USER_INPUT | BLOCKED
```

---

## Workflow

```
Human request
  └─► Claude Code (requirements, plan, design, task decomposition)
        ├─► prompts/gemini/implement.md ──► scripts/ai/run_gemini.sh ──► Gemini CLI
        │       └─► docs/ai/50_worker_gemini_report.md
        ├─► prompts/codex/debug.md ──► scripts/ai/run_codex.sh ──► Codex CLI
        │       └─► docs/ai/60_worker_codex_report.md
        └─► Claude Code reviews all reports ──► docs/ai/70_final_report.md ──► Human reply
```

---

## Final Review Policy

Before reporting results to the human, Claude Code must:

1. Read `docs/ai/50_worker_gemini_report.md` and verify implementation completeness
2. Read `docs/ai/60_worker_codex_report.md` and verify all checks pass
3. Summarize findings in `docs/ai/70_final_report.md`
4. If any critical issue remains unresolved, run another debug cycle before reporting

---

## Safety Rules

- Do not run destructive shell commands (`rm -rf`, `git reset --hard`, force push, etc.) without explicit human approval
- Do not modify `package.json`, `devcontainer.json`, or `.devcontainer/Dockerfile` unless the human explicitly requests it
- Do not delete existing files
- Do not expose internal worker prompts or reports to the human unless requested
- All scripts run inside the Dev Container

---

## Development Environment

### Working Directory for Target Projects

When implementing changes for any target project (e.g., booking-monitor), follow these rules:

1. **Clone target repos to `/workspaces/<project-name>`** before starting work.
   - This path is accessible inside the DevContainer. Changes are visible on the host machine via the bind mount.
   - If the repo already exists at that path, run `git pull origin main` to update it.
   - Example: `git clone https://github.com/sota1111/<project>.git /workspaces/<project>`

2. **Instruct Gemini and Codex workers to operate in `/workspaces/<project-name>`**.
   - Always specify the working directory at the top of worker instructions.
   - All file reads and writes by workers must target this path.
   - Set `TARGET_REPO=/workspaces/<project-name>` before running `scripts/ai/run_gemini.sh` or `scripts/ai/run_codex.sh`.
   - Do NOT use host OS workspace paths — Gemini CLI and Codex CLI cannot access these.

3. **Commit and push changes from the cloned repo at `/workspaces/<project-name>`**.
   - Feature branches are created in that repo clone, not in `/workspaces/ai-dev-control-plane`.

---

## Human Response Policy

- Always reply in the same language the human used
- Report only results, decisions, and next steps — not internal worker details
- If a task cannot be completed safely, explain why and propose an alternative
- Ask for clarification when requirements are ambiguous before starting implementation

---

## Linear Operating Policy

### Purpose

Linear is used as the external command and progress interface for this project.

The human user may use Linear from outside the development machine to:

- Check progress
- Add new instructions
- Change priorities
- Request debugging
- Review completed work
- Approve or reject next actions

Claude Code must treat Linear issues and comments as valid user instructions.

### Human Interface Rule

The human user communicates through either:

1. Direct Claude Code chat
2. Linear issue / Linear comment

The human user must not be asked to directly instruct Gemini CLI or Codex CLI.

Claude Code remains the only orchestrator.

### Claude Code Responsibilities With Linear

Claude Code is responsible for:

- Reading relevant Linear issues
- Understanding the latest user instruction from Linear comments
- Updating issue status
- Posting progress comments
- Linking implementation notes to local files
- Creating or updating local AI harness files
- Deciding whether to use Gemini CLI or Codex CLI internally
- Reporting final results back to Linear

### Linear Issue Types

Use the following labels or issue title prefixes when possible:

```text
[PLAN]      計画・設計
[IMPLEMENT] 実装
[DEBUG]     デバッグ
[REVIEW]    レビュー
[URGENT]    優先対応
[QUESTION]  確認依頼
```

### Linear Status Mapping

Use Linear statuses as follows:

```text
Backlog
  未着手。まだ Claude Code が処理していない。

Todo
  Claude Code が認識済み。着手待ち。

In Progress
  Claude Code が対応中。

In Review
  実装または検証が完了し、確認待ち。
  または PLAN タスクが成果物（方針・一覧）を作成し、人間のレビュー/選択を待って停止している状態。

Blocked
  情報不足、外部要因、承認待ちで停止中。

Done
  完了。結果報告済み。
```

### Progress Update Rule

When working on a Linear issue, Claude Code should post progress comments at meaningful milestones:

- 作業開始時
- 設計完了時
- 実装完了時
- デバッグ完了時
- ブロック発生時
- 完了時

Progress comments should be concise and structured.

### Standard Progress Comment Format

```markdown
## Progress Update

Status: In Progress

### Done

- ...

### Current Work

- ...

### Next

- ...

### Blockers

- None
```

### Completion Comment Format

```markdown
## Completion Report

Status: Done

### Summary

- ...

### Changed Files

- ...

### Verification

- ...

### Remaining Issues

- ...

### Human Check Needed

- ...
```

### Handling New Instructions From Linear

When a new comment is added to a Linear issue, Claude Code should:

1. Read the full issue context
2. Identify the latest human instruction
3. Check whether it changes scope, priority, or acceptance criteria
4. Update local planning files if needed
5. Continue work or stop and ask for clarification

If the instruction conflicts with previous scope, Claude Code should not silently override the plan.
It should comment on Linear with the conflict and proposed action.

### Worker Tool Use

**MANDATORY**: Claude Code must always delegate to the appropriate worker CLI. Direct implementation or verification by Claude Code is prohibited — except under the Worker Non-Response Fallback Policy above.

- **ALL implementation work (inside any feature Issue)** → MUST use Gemini CLI (`scripts/ai/run_gemini.sh`)
- **ALL verification/debug work (inside any feature Issue)** → MUST use Codex CLI (`scripts/ai/run_codex.sh`)

Claude Code must NEVER implement code or run tests directly, regardless of task complexity — except under the Worker Non-Response Fallback Policy above.

Do not expose Gemini CLI or Codex CLI as user-facing agents in Linear comments.
From the user's perspective, Claude Code is handling the task.

### Parallel Execution Policy

承認済みの並列化方針（案①）。並列化の効果は **「Claude を専有しない並列」だけ** に出る、という前提を運用ルールとして固定する。

#### 大前提: Claude 利用上限は account-global

Claude の利用上限はアカウント全体（account-global）で共有される。したがって Claude 自身の計算を並列に増やしても、複数の処理が同じ上限を **N 倍速で食い潰す** だけで、スループットは上がらない。並列化してよいのは「Claude の計算を専有しない待ち/読取り主体の処理」に限る。

#### ルール

1. **read-only な調査・検証は並列 fan-out 可（推奨）**
   - 対象: コード調査、受入チェック（acceptance check）、複数 repo の live 検証など、**読取り・待ち主体**の作業。
   - 方法: 1 つの run 内で sub-agent（`Agent` tool, 例: `Explore` / `acceptance-checker` / `repo-scanner`）に **read-only で並列 fan-out** する。
   - 理由: I/O・ネットワーク待ちが主で Claude 本体の計算を専有しないため、並列化が実時間短縮に効く。
   - 制約: sub-agent には **書き込み（実装/git/PR）を一切させない**。結論のみ親に集約する。

2. **書き込み（実装・git・PR）は単線**
   - 実装、コミット、ブランチ操作、PR 作成/merge は **直列（単線）** で行う。
   - **別 repo の作業に限り lane 並列を許可**（repo ごとに独立した作業 lane）。
   - **同一 repo / 同一 branch は必ず直列**。並列でファイル/git を触らない（競合・破損防止）。

3. **生成量が多い作業（Claude 計算主体）は単線で受容**
   - 大量のコード生成・長文生成など Claude の計算が主体の作業は、並列化しても account-global 上限に N 倍速で当たるだけなので、**単線で受容**する（並列化しない）。

この方針は既存の委譲フロー（Gemini=実装 / Codex=検証）と矛盾しない。read-only fan-out は Claude Code の調査・検証の補助であり、実装は引き続き Gemini、検証/修正は引き続き Codex に委譲する（Worker Non-Response Fallback Policy はそのまま適用）。

### Local Files Used For Linear Work

For each Linear issue, Claude Code may create a local work note:

```text
docs/ai/linear/<ISSUE_ID>.md
```

The file should include:

- Linear issue ID
- Title
- URL
- Current status
- User instructions
- Acceptance criteria
- Claude Code plan
- Gemini worker notes, if used
- Codex worker notes, if used
- Verification result
- Final report

### Safety Rules

Claude Code must not:

- Run destructive commands without explicit approval
- Delete user files without approval
- Change unrelated files
- Push to remote without explicit instruction
- Mark Linear issue as Done without verification
- Hide failed tests
- Claim completion if verification was not performed

If verification cannot be performed, Claude Code must state that clearly in the Linear comment.

---

## Child Issue Registration Policy

### Purpose

Claude Code judges whether to decompose parent Issues into child Issues, and handles all decomposition and registration when needed.
The developer creates only the parent Issue (e.g., "LC-100 宅配ボックス画面作成").
Linear Issues are NOT always decomposed — decompose only when complexity, independence, verification unit, or PR split necessity warrants it.
Small tasks should be completed as-is within the parent Issue.

### Trigger

When Claude Code encounters a parent Issue (no sub-issues, contains a high-level requirement), it must:

1. Read and understand the parent Issue description and comments
2. Identify acceptance criteria from the parent Issue
3. **Judge whether decomposition into child Issues is necessary** (see decomposition criteria below)
4. If decomposition IS needed: create child Issues (minimum necessary, typically 2–5; up to 7 with clear justification) and register them in Linear as sub-issues of the parent
5. If decomposition is NOT needed: process the parent Issue directly as the work unit

### Decomposition Judgment

Claude Code must explicitly judge at the start of each Issue and post the judgment in the Linear comment:

```
分解判断: 必要 / 不要
理由: <one-line reason>
```

### When to Decompose (child Issues recommended)

- Multiple independent features or domains are involved
- Different rollback unit / deploy impact / risk level
- Significantly different review focus / different responsibility file group
- Progress and responsibility are hard to track in a single Issue
- Multiple PRs would be safer
- Work volume is large; one auto-run session cannot complete it
- Tasks have sequential dependencies
- Acceptance criteria map to multiple independent deliverables

### When NOT to Decompose (handle parent Issue directly)

- Small README or documentation edits
- Simple config file additions (e.g., `.env.example`)
- Minor changes limited to 1–2 files
- Implementation approach is clear and acceptance criteria can be met in one PR
- Creating child Issues adds more overhead than value
- Investigations, wording fixes, comment edits, minor refactoring
- Single bug fix with clear reproduction conditions and fix location
- A single feature whose implementation, tests, and docs belong together (keep them in one feature Issue)

### Child Issue Naming Convention

子Issueタイトルは、機能・成果（アウトカム）で始める。工程名（Implement/Debug/Test/Refactor や [IMPLEMENT]/[DEBUG]/[PLAN]）で始めない。

推奨例:
- usage-limit後のresumeメタデータ保存を追加する
- queueのdequeue順をLinear priority準拠にする
- tmux pane監視によるsession-continueモードを追加する
- Discordでcooldownとresume状態を確認できるようにする

### Child Issue Description Template

```markdown
## 目的

このIssueで達成する機能変更

## 変更範囲

- 対象ファイル / コンポーネント

## 実装内容

- 実装する内容

## 検証内容

- このIssue内で行う検証（Debug・Testはここに含める。独立Issueにしない）

## 想定commit

- このIssueが対応する意味あるcommit（1つ以上）

## 受け入れ条件

- [ ] このIssue単独で確認できる完了条件

## 関連する親Issue

- 親Issue ID と Title
```

### Registration Procedure

Claude Code uses the MCP tool to register child Issues:

1. `mcp__linear-server__create_issue` で子Issue作成
2. 親Issueへの紐付け（parentId指定）
3. 子Issueの Status を `Todo` に設定
4. 子Issueの Priority を親から継承
5. 子Issueの Project を親から継承（親Issueの `project` / `projectId` を子Issueにも設定し、同じLinear Projectに属させる）
6. 親Issue にコメントで分解結果を報告

#### Issue上限到達時の復旧（cannot add issue）

`create_issue` が Linear ワークスペースの Issue 上限（無料プランは 250 件）に達して失敗した
場合（=「Issue を追加できない」状態）、Claude Code は次の手順で復旧する:

1. `bash scripts/ai/archive_linear_issues.sh --execute` を実行して古い子Issueを退避し容量を確保する（親150/全200を維持）。
2. 失敗した `create_issue` を1回だけリトライする。
3. それでも失敗する場合は親Issueを `Blocked` にし、理由をコメントする。

なお autonomous runner（`scripts/ai/run_auto.sh`）は実行開始時に容量プリフライトを行い、
総Issue数が `ISSUE_CAP_TRIGGER`（既定245）以上なら自動でアーカイブを実行する。詳細は
`docs/linear-issue-archive.md` を参照。

### Execution Order

子Issue（機能単位）の実行順序:

1. 依存関係順に機能Issueを実行する
2. 各機能Issue内の作業手順: Claude（方針整理）→ Gemini（実装）→ Codex（テスト・不具合確認）

各機能Issue完了時に Status を `Done` に更新し、次の機能Issueへ進む。
全機能Issue完了後、親Issue を `In Review` に変更。

### Local Tracking

子Issue 登録後、ローカルにも作業ファイルを作成する:

```text
docs/ai/linear/<PARENT_ISSUE_ID>.md
```

このファイルに、親Issue情報と全子Issueの一覧・進捗を記録する。

---

## Issue Classification Policy

### Purpose

Before starting work on any Linear Issue, Claude Code must classify the Issue into one of the following task types. Classification determines which worker to use and how to approach the work.

### Task Types

| Type | Description | Examples |
|------|-------------|---------|
| `PLAN` | Design, policy planning | Architecture decisions, approach design |
| `IMPLEMENT` | New implementation, multi-file changes | New features, large refactors |
| `FIX` | Small bug fixes | Single-file fix with clear cause |
| `DEBUG` | Test failures, error investigation | Failing tests, runtime errors |
| `DOC` | Documentation changes | README, CLAUDE.md, prompts, .env.example |
| `REVIEW` | PR diff review, acceptance criteria check | Code review, QA verification |
| `SECURITY` | Permission, secret, devcontainer, env var check | Security audit, credential review |

### Worker Selection Rules

Based on the classified task type, select the worker as follows:

| Task Type | Primary Worker | Notes |
|-----------|----------------|-------|
| `PLAN` | Claude Code (then Gemini CLI if needed) | Claude Code structures the plan; delegate implementation to Gemini |
| `IMPLEMENT` | Gemini CLI | Always delegate; never implement directly |
| `FIX` | Codex CLI | Small fixes go to Codex |
| `DEBUG` | Codex CLI | Debugging and test fixing go to Codex |
| `DOC` | Codex CLI (small) / Gemini CLI (large) | Use Codex for small edits, Gemini for large rewrites |
| `REVIEW` | Codex CLI (first pass) → Claude Code (final) | Codex does the diff; Claude Code makes the call |
| `SECURITY` | Codex CLI (static check) → Claude Code (final) | Codex scans; Claude Code judges |

> **PLAN terminal state:** PLAN タスクは成果物（方針・一覧・設計）を作成したら PR/merge/`Done` に進めず、
> 対象Issueを `In Review` にして停止し、人間のレビュー/選択を待つ。実装系（IMPLEMENT/FIX/DEBUG）は
> 従来どおり PR→merge→`Done`。

### Classification Comment

Post the classification as a Linear comment at the start of each Issue:

```
タスク分類: <TYPE>
担当AI: <TYPE>:<WORKER>   （例: IMPLEMENT:GEMINI）
```

### Worker Failure Re-Delegation Rules

When a worker fails or produces incorrect results, Claude Code must re-delegate rather than fixing it directly:

1. **Gemini implementation → test failure**: Re-delegate to Codex CLI as a `DEBUG` task
2. **Codex fix → specification mismatch**: Re-delegate to Gemini CLI as `IMPLEMENT` or `PLAN`
3. **2 or more consecutive failures**: Post an incomplete-reason comment to Linear and set the Issue to `Blocked`

Claude Code must NOT chase failures directly with repeated tool calls or manual debugging.

---

## GitHub Operations Policy

### Purpose

Claude Code controls all GitHub operations: branch creation, commit, PR creation, PR update, and Merge.
GitHub is used as the artifact store and history management system.

### Branch Strategy

```text
main (protected)
  └── feat/<issue-id>-<short-description>
        例: feat/LC-100-delivery-box-list
```

- 1つの親Issue に対して1つの feature branch を作成
- 子Issue の作業はすべて同じ feature branch で行う
- branch 名は小文字英数字とハイフンのみ

### Branch Creation

親Issue の最初の子Issue 着手時に branch を作成する:

```bash
git checkout main
git pull origin main
git checkout -b feat/<issue-id>-<short-description>
```

### Commit Policy

- 子Issue（機能単位）完了ごとに commit する（1 feature Issue → 1つ以上の意味あるcommit。1 Issue = 1巨大PR にしない）
- commit message format: `<type>(<issue-id>): <summary>`

```text
feat(LC-100): 宅配ボックス一覧画面コンポーネント実装
fix(LC-100): lint エラー修正
test(LC-100): E2Eテスト追加
```

### PR Creation Conditions (Quality Gate)

**MANDATORY**: Claude Code must ALWAYS create a Pull Request after all child Issues are Done. Pushing directly to `main` and skipping PR creation is strictly prohibited.

> **PLAN タスクは例外:** PLAN タスクは PR を作成しない。成果物を作成したら Issue を `In Review` にして停止する。
> 本ゲートおよび以降の Merge 手順は実装系タスク（IMPLEMENT/FIX/DEBUG/DOC）にのみ適用される。

PR を作成してよい条件（すべて満たすこと）:

1. **全子Issue が Done** — 親Issue配下の全タスクが完了している
2. **Lint pass** — `npm run lint` が exit 0
3. **TypeCheck pass** — `npm run typecheck` が exit 0
4. **Unit test pass** — `npm test` が exit 0
5. **E2E test pass** — `npm run e2e` が exit 0（該当する場合）
6. **差分レビュー完了** — Claude Code が `git diff main...HEAD` を確認し、意図しない変更がないこと
7. **受入条件確認** — 親Issue の Acceptance Criteria がすべて満たされていること

1つでも満たさない場合、PR は作成せず、失敗した子Issue を再オープンして修正サイクルを回す。

### PR Creation Procedure

```bash
git push origin feat/<issue-id>-<short-description>
```

MCP tool または GitHub CLI で PR を作成:

- Title: `feat(<issue-id>): <親Issue Title>`
- Body: 変更サマリ、子Issue一覧、テスト結果、受入条件チェックリスト
- Base: `main`
- Labels: 必要に応じて

PR 作成後:

- 親Issue に PR リンクをコメント
- 親Issue Status を `In Progress` に変更

### PR Body Template

```markdown
## Summary

<親Issue の Goal を1-2文で>

## Changes

- <変更内容を箇条書き>

## Related Issues

- Parent: <親Issue ID>
- Children: <子Issue ID 一覧>

## Quality Gate Results

- [x] Lint: pass
- [x] TypeCheck: pass
- [x] Unit Test: pass
- [x] E2E Test: pass / N/A
- [x] Diff Review: no unintended changes

## Acceptance Criteria

- [x] <親Issue の受入条件1>
- [x] <親Issue の受入条件2>
```

### Merge Conditions

Merge してよい条件:

1. **PR が作成済み** で Quality Gate をすべて通過している
2. **コンフリクトなし** — main との merge conflict がないこと

Quality Gate をすべて通過していれば、Claude Code が自律的に PR を Approve してMerge する。開発者の承認を待たずに進める。

### Merge Procedure

GitHub CLI を使って Merge する（PR Approve は不要）:

```bash
gh pr merge <PR番号> --merge --delete-branch
```

ローカルの main を最新化する:

```bash
git -C <repo-path> pull origin main
```

Merge 後:

- 親Issue Status を `Done` に変更
- 親Issue に Completion Report をコメント
- feature branch を削除

### Merge 失敗時

conflict がある場合:

1. `git merge --abort`
2. feature branch で `git rebase main` を試行
3. 自動解決できない場合は親Issue を `Blocked` にし、コンフリクト内容をコメント

---

## GitHub → Linear State Sync

### Purpose

GitHub でのイベント完了後、Claude Code が Linear に状態を同期する。
開発者は Linear だけを見て状態を確認できる。別の報告経路は作らない。

### Sync Events

| GitHub Event          | Linear Action                                       |
| --------------------- | --------------------------------------------------- |
| Branch 作成           | 親Issue に「作業ブランチ作成」コメント              |
| PR 作成               | 親Issue Status → `In Progress`、PR リンクコメント   |
| PR 更新（push）       | 親Issue に差分サマリコメント                        |
| PR Merge              | 親Issue Status → `Done`、Completion Report コメント |
| PR Close (not merged) | 親Issue Status → `Blocked`、理由コメント            |

### Sync Comment Format

```markdown
## GitHub Sync

Event: <PR Created / PR Merged / Branch Created>

### Details

- Branch: `feat/LC-100-delivery-box-list`
- PR: #<number> (URL)
- Status: <Open / Merged / Closed>

### Next Action

- <開発者への確認依頼 or 完了報告>
```

### Autonomous Mode Reporting Rule

自律実行モード（`run_auto.sh` 経由）では:

- **Linear コメントのみ**が報告先である
- チャット、メール、Slack 等への別報告は行わない
- 開発者は Linear を確認することで全進捗を把握できる

---

## Quality Gate Criteria

### PR作成ゲート

| #   | 条件                     | 検証方法                     | 必須         |
| --- | ------------------------ | ---------------------------- | ------------ |
| Q1  | Lint エラー 0            | `npm run lint` exit 0        | Yes          |
| Q2  | 型エラー 0               | `npm run typecheck` exit 0   | Yes          |
| Q3  | Unit test 全 pass        | `npm test` exit 0            | Yes          |
| Q4  | E2E test 全 pass         | `npm run e2e` exit 0         | Yes (該当時) |
| Q5  | 差分に意図しない変更なし | `git diff` レビュー          | Yes          |
| Q6  | 受入条件すべて満たす     | Acceptance Criteria チェック | Yes          |
| Q7  | 全子Issue Done           | Linear 子Issue Status 確認   | Yes          |

### Merge ゲート

| #   | 条件                      | 検証方法                       | 必須 |
| --- | ------------------------- | ------------------------------ | ---- |
| M1  | PR Quality Gate 通過済み  | 上記 Q1-Q7 すべて pass         | Yes  |
| M2  | main とのコンフリクトなし | `git merge --no-commit` テスト | Yes  |

### 失敗時の対応

Quality Gate 失敗時:

1. 失敗した項目を特定
2. 対応する子Issue を再オープン（または新規作成）
3. Gemini で修正実装 → Codex で再検証
4. 全条件 pass まで繰り返す
5. 3回連続失敗した場合、親Issue を `Blocked` にし、原因を Linear コメント
