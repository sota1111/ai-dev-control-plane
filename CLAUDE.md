# CLAUDE.md — AI Harness Specification

## Overview

Claude Code is the **sole interface between the human and all AI workers**.
The human never speaks directly to Antigravity CLI or Codex CLI.
From the human's perspective, Claude Code handles everything.

---

## Role Assignments

### Claude Code (Orchestrator)

Claude Code focuses on **judgment, delegation, and final approval** — not direct implementation.

**Responsibilities:**
- Single point of contact with the human
- Reading and classifying Linear Issues
- Judging whether child Issue decomposition is needed
- Selecting the appropriate worker (Antigravity CLI / Codex CLI)
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

### Antigravity CLI (Implementation Worker)

- Implementing features across multiple files
- Creating UI, API, and business logic
- Writing implementation result reports to `docs/ai/50_worker_antigravity_report.md`

### Codex CLI (Debug & Verification Worker)

- Running lint / typecheck / test
- Browser verification via Playwright
- Identifying root causes of failures
- Applying minimal fixes
- Writing debug result reports to `docs/ai/60_worker_codex_report.md`

---

## Worker Dispatch — always go through `scripts/ai/run_worker.sh` (SOT-1459)

**MANDATORY**: Claude Code must NEVER call `scripts/ai/run_codex.sh`, `scripts/ai/run_antigravity.sh`,
or a nested `claude` directly for role work. **AI does not call AI** — every role's worker is selected
by the dispatcher script `scripts/ai/run_worker.sh <role>`. This is the single entry point for all
delegated work.

How it works:
1. Write the role's worker-agnostic instruction to `prompts/roles/<role>.md` (see `prompts/roles/TEMPLATE.md`).
2. Run `scripts/ai/run_worker.sh <role>` (set `TARGET_REPO=…` first when working a target repo).
3. The dispatcher reads the role's **ordered priority chain** from `config/worker_roles.json`, tries each
   worker in order via its run script (`run_codex.sh` / `run_claude.sh` / `run_antigravity.sh`), and:
   - copies your `prompts/roles/<role>.md` into whichever worker it picks;
   - on **non-response / usage-limit** (exit `75`) **hands off** to the next worker in the chain, passing
     the previous worker's partial report so work CONTINUES (no restart);
   - on the first success (exit `0`) stops and prints `WORKER_DISPATCH_DONE role=<role> worker=<w> report=<path>` — read that report;
   - if every worker is non-responsive prints `WORKER_DISPATCH_EXHAUSTED` and exits `75` → Claude Code takes over per the Worker Non-Response Fallback Policy.
4. Consecutive invocations of the **same** worker reuse that CLI's session so the conversation/prompt
   cache stays warm — claude via `--session-id`/`--resume`, codex via `exec resume --last`, antigravity
   via `--continue` (disable with `WORKER_SESSION_REUSE=0`; per-run session state is reset by
   `run_auto.sh`).

`prompts/antigravity/implement.md`, `prompts/codex/debug.md`, and `prompts/claude/worker.md` remain the
per-worker prompt files the dispatcher writes into; the canonical, worker-agnostic role instruction lives
in `prompts/roles/<role>.md`.

### Script-driven role pipeline (案B / default; SOT-1459)

For a targeted issue (any autonomous run — `runner.ts` always injects `WEBHOOK_ISSUE_ID`), **`run_auto.sh`
itself sequences the whole lifecycle as a script** — no single all-controlling Claude orchestrator. It runs,
in order, `scripts/ai/run_worker.sh <role>` for: **task-check → decomposition → implementation →
verification → acceptance → github → linear-report**, using the committed `prompts/roles/<role>.md` (which
read `docs/ai/pipeline/context.md` for the issue id / target repo). After each role it reads the winning
report's `## Next Action` and gates:
- `task-check` not-actionable (`NEEDS_USER_INPUT`/`BLOCKED`) → stop as a successful no-op (exit 0);
- `verification`/`acceptance` `NEEDS_DEBUG` → loop back to `implementation` (bounded by
  `PIPELINE_MAX_DEBUG_CYCLES`, default 2);
- any `BLOCKED`/`NEEDS_USER_INPUT`, or a dispatcher `WORKER_DISPATCH_EXHAUSTED` → stop (exit `70`,
  needs human);
- all roles `READY_FOR_REVIEW` → pipeline complete (exit 0).

This makes the工程順序 deterministic and script-owned; each role is a dispatched worker (Claude only
participates as the worker its chain selects, not as an orchestrator). Escape hatch: `PIPELINE_MODE=0`
(or a run with no issue id, e.g. a manual queue scan) falls back to the legacy single Claude-orchestrator
launch, which routes each role through the dispatcher via its prompt instructions.

### Per-issue worker override from Linear (SOT-1459)

A human can steer which worker handles a role for **one issue** by writing a directive line in the Linear
issue description or a comment:

```
workers: implementation=codex, verification=claude
```

- Each `role=chain` pair overrides that role's worker chain **for this issue's pipeline only**; roles not
  mentioned keep the `config/worker_roles.json` default. Roles: `task-check`, `decomposition`,
  `implementation`, `verification`, `acceptance`, `github`, `linear-report`. Workers: `claude`, `codex`,
  `antigravity` (alias `agy`).
- A chain may list fallbacks with `>` (or `|` / `/`): `workers: implementation=codex>claude`.
- `workers:` may appear in the description or any comment; the **newest occurrence wins** for a role.
- Mechanics: at pipeline start `run_auto.sh` calls `runner-cli resolve-worker-roles <issue>`, which reads
  the issue's description + comments, merges the overrides onto the base config, writes a per-issue
  `docs/ai/pipeline/worker_roles.<issue>.json`, and exports `WORKER_ROLES_FILE` so every `run_worker.sh`
  in the run uses it. Fail-open: no directive / fetch error → the default config is used. Parser +
  merge: `src/lib/workerRoleDirective.ts`.

---

## Worker Non-Response Fallback Policy

- **Definition of "non-response" (worker unavailable).** A worker run counts as non-responsive when ANY of these is true:
  - the worker run script exits with the dedicated non-response code `75` (set by `scripts/ai/run_antigravity.sh` / `scripts/ai/run_codex.sh` / `scripts/ai/run_claude.sh`), or
  - the worker CLI exits non-zero (crash, auth failure, usage-limit, etc.), or
  - the worker invocation times out (exceeds the configured timeout), or
  - the worker report file (`docs/ai/50_worker_antigravity_report.md` for Antigravity, `docs/ai/60_worker_codex_report.md` for Codex, `docs/ai/55_worker_claude_report.md` for a dispatched Claude worker) is missing, empty, or lacks a `## Next Action` line after the run.
  - Within a role's priority chain the dispatcher `scripts/ai/run_worker.sh` treats each of these per worker and hands off to the next worker; only when the WHOLE chain is exhausted (`WORKER_DISPATCH_EXHAUSTED`, exit `75`) does Claude Code fall back and perform the role directly.
- **Fallback rule.** Claude Code must FIRST attempt normal delegation. Only when a worker is non-responsive per the definition above, Claude Code MAY take over that worker's role and perform the implementation (Antigravity's role) or verification/fix (Codex's role) directly, so the Issue is not blocked. This is an explicit, narrowly-scoped EXCEPTION to the otherwise-mandatory delegation rules.
- **Bounded retry.** Retry a non-responsive worker AT MOST once before falling back. Never loop on a hung or failing worker.
- **Quality unchanged.** All Quality Gates (lint / typecheck / test / diff review / acceptance criteria) apply identically whether the work was done by the worker or by Claude Code fallback.
- **Disclosure / audit.** When Claude Code falls back, it MUST record (a) which worker was non-responsive, (b) the detected failure mode, and (c) that Claude Code performed the work directly — in the relevant worker report file (the audit sink). Do NOT post this fallback disclosure as a Linear comment: Linear receives only the work result. The human needs the outcome of the delegation, not the fallback mechanics.
- **Global kill-switches removed (`ALL_CLAUDE_MODE`, `WORKER_MODE`).** The former global env switches that overrode per-role assignment for every role at once have been removed. Worker selection is now governed solely by `config/worker_roles.json` (below). To run everything on Claude, set all roles to `claude` in that file; to run only one worker, assign roles accordingly. The run scripts no longer read `ALL_CLAUDE_MODE` or `WORKER_MODE`.
- **Per-worker disable flags (`CODEX_DISABLED` / `ANTIGRAVITY_DISABLED` / `CLAUDE_DISABLED`).** A truthy value (`1|true|yes|on`, case-insensitive) makes that worker's run script exit `75`, so the dispatcher skips it and hands off to the next worker in the chain while that CLI is temporarily unavailable. These are per-worker *availability* escape hatches (worker down), NOT role-assignment overrides — each is evaluated *after* chain selection, inside the worker's own run script. Default off.
- **Per-role priority chains (`config/worker_roles.json`, SOT-1459) — the top-level worker selector.** This file is the single source of truth for which worker handles each role. Each harness role — `task-check`, `decomposition`, `implementation`, `verification`, `acceptance`, `github`, `linear-report` — maps to an **ordered priority chain** of workers (`claude` | `codex` | `antigravity`), e.g. `"task-check": ["codex","claude","antigravity"]`: index 0 is the primary (tried first), the rest are the fallback order. A bare string is accepted as a single-element chain. Keys starting with `__` are documentation and ignored. The dispatcher `scripts/ai/run_worker.sh <role>` reads the chain, sets `RUN_WORKER_DISPATCH=1`, and tries each worker's run script in order — on non-response (`75`) or usage-limit it hands off to the next worker, passing the partial report so work continues; the first success wins. **Precedence:** this per-role config is the top-level worker selector (the former global switches `ALL_CLAUDE_MODE` / `WORKER_MODE` were removed) — evaluated *before* the per-worker availability flags (`CODEX_DISABLED` / `ANTIGRAVITY_DISABLED` / `CLAUDE_DISABLED`) and the usage-limit cooldown, which apply per worker. To run everything on Claude, set every role to `["claude"]`. Fail-open: a missing/invalid config or unknown role makes the dispatcher exit `75` (Claude Code fallback). Loading/validation helper: `src/lib/workerRoles.ts` (`loadWorkerRolesConfig` / `resolveRoleChain` / `resolveRoleWorker`). `github` (branch/PR/merge) and `linear-report` (Linear state sync + progress reporting) are Claude-primary by default; putting `codex`/`antigravity` first reroutes that role's primary accordingly.

### Roles the orchestrator maps to workers (SOT-1459)

When acting on a feature Issue, Claude Code writes the role instruction to `prompts/roles/<role>.md` and
runs the dispatcher `scripts/ai/run_worker.sh <role>` (which sets `WORKER_ROLE=<role>` and selects the
worker from the role's priority chain). The default chains below are the committed values in
`config/worker_roles.json` (primary first, then fallback order). Every role — including the
Claude-primary ones — goes through the dispatcher; if a role's chain is `["claude"]` (or Claude wins the
chain), `run_claude.sh` runs a dispatched Claude worker rather than the orchestrator acting inline.

| Role (config key) | 役割 | Default priority chain |
| --- | --- | --- |
| `task-check` | タスク確認 | `["codex","claude","antigravity"]` |
| `decomposition` | タスク分割 | `["claude","codex","antigravity"]` |
| `implementation` | 実装 | `["antigravity","codex","claude"]` |
| `verification` | 検証 | `["codex","claude","antigravity"]` |
| `acceptance` | 受け入れ | `["claude","codex","antigravity"]` |
| `github` | GitHub連携 (branch/PR/merge) | `["claude","codex","antigravity"]` |
| `linear-report` | Linear報告 (状態同期・進捗報告) | `["claude","codex","antigravity"]` |

---

## Instruction Prompt Templates

### Antigravity CLI instruction template (`prompts/antigravity/implement.md`)

```
# Antigravity Worker Instruction

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
Write your implementation report to `docs/ai/50_worker_antigravity_report.md` using this format:

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
- docs/ai/50_worker_antigravity_report.md

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

Autonomous (targeted issue) — script-driven role pipeline (案B, default):

```
Linear webhook / queue ─► runner.ts (injects WEBHOOK_ISSUE_ID) ─► run_auto.sh (pipeline)
  └─ for each role in [task-check, decomposition, implementation, verification, acceptance, github, linear-report]:
        scripts/ai/run_worker.sh <role>
          ├─ reads config/worker_roles.json chain, copies prompts/roles/<role>.md into the picked worker
          ├─ run_codex.sh / run_claude.sh / run_antigravity.sh  (chain order; hand off on exit 75)
          │     └─ docs/ai/{60_codex,55_claude,50_antigravity}_worker_report.md
          └─ WORKER_DISPATCH_DONE ─► run_auto.sh gates on ## Next Action (proceed / loop / stop)
```

Legacy fallback (`PIPELINE_MODE=0`, or a manual run with no issue id):

```
Human request / queue scan
  └─► Claude Code orchestrator (requirements, plan, decomposition)
        └─► routes each role through scripts/ai/run_worker.sh <role> (per its prompt instructions)
```

---

## Final Review Policy

Before reporting results to the human, Claude Code must:

1. Read `docs/ai/50_worker_antigravity_report.md` and verify implementation completeness
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

2. **Instruct Antigravity and Codex workers to operate in `/workspaces/<project-name>`**.
   - Always specify the working directory at the top of worker instructions.
   - All file reads and writes by workers must target this path.
   - Set `TARGET_REPO=/workspaces/<project-name>` before running `scripts/ai/run_antigravity.sh` or `scripts/ai/run_codex.sh`.
   - Do NOT use host OS workspace paths — Antigravity CLI and Codex CLI cannot access these.

3. **Commit and push changes from the cloned repo at `/workspaces/<project-name>`**.
   - Feature branches are created in that repo clone, not in `/workspaces/ai-dev-control-plane`.

---

## Human Response Policy

- Always reply in the same language the human used
- Report only results, decisions, and next steps — not internal worker details
- If a task cannot be completed safely, explain why and propose an alternative
- Ask for clarification when requirements are ambiguous before starting implementation

### Requirement-Clarification Step (着手前の要件明確化, SOT-1421 / P4)

Terse one-line requirements are the single biggest source of wasted work: their interpretation drifts,
so the same Issue is reopened 2–5 times. Before implementing an ambiguous Issue, do this ONCE up front:

1. **State your interpretation.** Post a Linear comment that restates, in one or two lines, exactly
   what you understand the requirement to mean and what you will change (files/behavior).
2. **List the ambiguities.** Bullet any assumptions or points where the requirement could reasonably
   mean more than one thing.
3. **Decide whether to proceed or stop:**
   - If there is a single obviously-correct reading (or a safe conventional default), state the
     interpretation, proceed, and note it in the completion report for the human to confirm.
   - If interpretations genuinely diverge in a way that changes the deliverable, present the options
     and set the Issue to `In Review`, stopping for the human to choose. Do NOT guess-and-reopen.
4. **Autonomous mode:** the interpretation/ambiguity note is a Linear comment (the only report channel).
   Never block waiting for a reply when a safe default exists — proceed on the default and disclose it.

This applies to feature/FIX/IMPLEMENT Issues with a vague scope; skip it for Issues whose scope is
already unambiguous.

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

The human user must not be asked to directly instruct Antigravity CLI or Codex CLI.

Claude Code remains the only orchestrator.

### Claude Code Responsibilities With Linear

Claude Code is responsible for:

- Reading relevant Linear issues
- Understanding the latest user instruction from Linear comments
- Updating issue status
- Posting progress comments
- Linking implementation notes to local files
- Creating or updating local AI harness files
- Deciding whether to use Antigravity CLI or Codex CLI internally
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

Status: In Review

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

- **ALL implementation work (inside any feature Issue)** → MUST use Antigravity CLI (`scripts/ai/run_antigravity.sh`)
- **ALL verification/debug work (inside any feature Issue)** → MUST use Codex CLI (`scripts/ai/run_codex.sh`)

Claude Code must NEVER implement code or run tests directly, regardless of task complexity — except under the Worker Non-Response Fallback Policy above.

Do not expose Antigravity CLI or Codex CLI as user-facing agents in Linear comments.
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

この方針は既存の委譲フロー（Antigravity=実装 / Codex=検証）と矛盾しない。read-only fan-out は Claude Code の調査・検証の補助であり、実装は引き続き Antigravity、検証/修正は引き続き Codex に委譲する（Worker Non-Response Fallback Policy はそのまま適用）。

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
- Antigravity worker notes, if used
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

### Facet Issue Clustering (関連Issueの親配下クラスタリング, SOT-1421 / P8)

When one feature area accumulates many small, related Issues over time (e.g. the "締切調査 (deadline
investigation)" cluster spanned 12+ separate Issues), the scattering multiplies context re-derivation
and duplicate review cost. When you notice several Issues that are facets of the same feature/domain:

- **Prefer clustering under one parent.** Create (or reuse) a parent Issue for the feature area and
  register the related Issues as its sub-issues, rather than leaving them as independent top-level
  Issues. Inherit the parent's Project/Priority per the Registration Procedure below.
- **Signal for clustering:** the Issues share a file group / component, repeatedly reopen against each
  other, or their titles reference the same feature noun (a "facet" of one thing).
- **Do NOT over-cluster:** genuinely independent features stay separate. Only group Issues that are
  facets of a single feature/domain and would otherwise fragment progress tracking.
- This is an organizing judgment applied when triaging, not a reason to fabricate parent/child links
  between unrelated work.

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
2. 各機能Issue内の作業手順: Claude（方針整理）→ Antigravity（実装）→ Codex（テスト・不具合確認）

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
| `PLAN` | Claude Code (then Antigravity CLI if needed) | Claude Code structures the plan; delegate implementation to Antigravity |
| `IMPLEMENT` | Antigravity CLI | Always delegate; never implement directly |
| `FIX` | Codex CLI | Small fixes go to Codex |
| `DEBUG` | Codex CLI | Debugging and test fixing go to Codex |
| `DOC` | Codex CLI (small) / Antigravity CLI (large) | Use Codex for small edits, Antigravity for large rewrites |
| `REVIEW` | Codex CLI (first pass) → Claude Code (final) | Codex does the diff; Claude Code makes the call |
| `SECURITY` | Codex CLI (static check) → Claude Code (final) | Codex scans; Claude Code judges |

> **PLAN terminal state:** PLAN タスクは成果物（方針・一覧・設計）を作成したら PR/merge/`Done` に進めず、
> 対象Issueを `In Review` にして停止し、人間のレビュー/選択を待つ。実装系（IMPLEMENT/FIX/DEBUG）は
> PR→merge まで進め、その後は `Done` にせず `In Review` にして人間のレビューを待つ。

### Classification Comment

Post the classification as a Linear comment at the start of each Issue:

```
タスク分類: <TYPE>
担当AI: <TYPE>:<WORKER>   （例: IMPLEMENT:ANTIGRAVITY）
```

### Worker Failure Re-Delegation Rules

When a worker fails or produces incorrect results, Claude Code must re-delegate rather than fixing it directly:

1. **Antigravity implementation → test failure**: Re-delegate to Codex CLI as a `DEBUG` task
2. **Codex fix → specification mismatch**: Re-delegate to Antigravity CLI as `IMPLEMENT` or `PLAN`
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

### Bug Issue Registration (Bug ラベル時)

対象 Linear Issue に **`Bug` ラベル**が付いている場合、通常の PR フローに加えて GitHub Issue を
作成し、PR と紐づける。これにより不具合は GitHub 上でも追跡され、PR の merge で自動クローズされる。

適用条件:
- PR を作成する実装系タスク（IMPLEMENT / FIX / DEBUG / DOC）のみ。PLAN タスクは PR を作らないため
  GitHub Issue も作成しない。
- 親 Linear Issue 1 件につき GitHub Issue 1 件（子Issue ごとには作らない）。
- Quality Gate 通過後、PR 作成の直前に実行する（中断時の孤児 Issue を避けるため）。

手順:

1. GitHub Issue を作成し、Issue 番号 `<N>` を控える:

   ```bash
   gh issue create \
     --title "<Linear Issue Title>" \
     --body "<Linear Issue の説明 + 受け入れ条件 + Linear URL + Linear ID>" \
     --label bug
   ```

   - `--label bug` は対象リポジトリに `bug` ラベルが存在する場合のみ付与する。存在しなければ
     `--label` を省略する（ラベル不在で失敗させない）。

2. PR Body に **closing keyword** `Closes #<N>` を含め、PR と GitHub Issue を紐づける
   （merge で GitHub Issue が自動クローズされる）。下記 PR Body Template の "Related Issues" を参照。

3. 作成した GitHub Issue の URL を親 Linear Issue にコメントで記録する。

GitHub Issue の作成・紐づけに失敗しても PR フロー自体は止めない（best-effort）。失敗時は親 Linear
Issue にその旨をコメントし、PR は通常どおり作成・merge する。

### Snapshot Attachment (snapshot ラベル時)

対象 Linear Issue に **`snapshot` ラベル**が付いている場合、通常の PR フローに加えて、**変更後
（after）の画面スクリーンショット**を撮影し、PR と Linear Issue の両方に画像として添付する。
これにより、画面に対する変更が視覚的に追跡・レビューできる。

適用条件:
- PR を作成する実装系タスク（IMPLEMENT / FIX / DEBUG / DOC）のみ。PLAN タスクは PR を作らないため
  スクショ添付も行わない。
- 親 Linear Issue 1 件につき、変更を反映した画面のスクショを最低 1 枚（複数画面に渡る場合は該当
  画面ごと）。
- Quality Gate 通過後、PR 作成の直前に実行する。

手順:

1. **after スクショの撮影。** 対象プロジェクトの既存 e2e / Playwright モックハーネス
   （`installApiMocks` / `login` 等）を流用した一時 spec で、変更後の対象画面を撮影する。
   - 撮影画像はリポジトリ内（例: `docs/screenshots/`）に commit し、commit SHA を控える。
   - UI を伴わない変更（バックエンドのみ・ドキュメントのみ等で可視画面が無い場合）は撮影を省略し、
     その旨を Linear にコメントで記録する（無理にスクショを作らない）。

2. **PR への添付。** PR Body に、commit SHA を含む永続 URL
   （`https://raw.githubusercontent.com/<owner>/<repo>/<commit-sha>/docs/screenshots/<file>`）で
   `![after](...)` として画像を埋め込む。下記 PR Body Template の "Snapshot" を参照。

3. **Linear への添付。** `mcp__linear-server__prepare_attachment_upload` → 返却された署名付き URL
   へ `curl -X PUT`（署名ヘッダは verbatim、60 秒以内）→ `mcp__linear-server__create_attachment_from_upload`
   で Issue に添付する。`uploads.linear.app` の URL は Issue コメントに `![after](...)` として
   インライン表示する。

スクショの撮影・添付に失敗しても PR フロー自体は止めない（best-effort）。失敗時は親 Linear Issue に
その旨をコメントし、PR は通常どおり作成・merge する。

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
- Closes #<GitHub Issue 番号>   <!-- Bug ラベル時のみ。PR と GitHub Issue を紐づけ自動クローズ -->

## Quality Gate Results

- [x] Lint: pass
- [x] TypeCheck: pass
- [x] Unit Test: pass
- [x] E2E Test: pass / N/A
- [x] Diff Review: no unintended changes

## Snapshot

<!-- snapshot ラベル時のみ。変更後（after）画面のスクショを commit SHA 永続 URL で埋め込む -->
![after](https://raw.githubusercontent.com/<owner>/<repo>/<commit-sha>/docs/screenshots/<file>)

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

- 親Issue Status を `In Review` に変更（人間のレビュー待ち。`Done` には自動で進めない）
- 親Issue に Completion Report をコメント
- feature branch を削除
- **自動redeploy（best-effort, SOT-1421 / P6）**: merge 後に `scripts/ai/redeploy_after_merge.sh
  <repo-or-project> [localPath]` を呼び、対象repoにdeployコマンドが設定されていれば起動する。
  既定は無効（`REDEPLOY_ENABLED` が真値のときのみ実行）で、deployコマンドは `REDEPLOY_CMD` か
  `config/deploy_commands.json`（キー=repoスラッグ/プロジェクト名）で設定する。未設定・未有効・
  deploy失敗のいずれでも exit 0（best-effort。merge/flow を止めない）。実deployは環境の
  credential依存のため、credentialのある環境で有効化する。失敗時はその旨を Linear に記録する。

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
| PR Merge              | 親Issue Status → `In Review`、Completion Report コメント |
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
3. Antigravity で修正実装 → Codex で再検証
4. 全条件 pass まで繰り返す
5. 3回連続失敗した場合、親Issue を `Blocked` にし、原因を Linear コメント
