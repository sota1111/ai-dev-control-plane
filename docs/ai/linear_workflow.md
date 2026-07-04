# Linear Workflow for Claude Code AI Harness

## Purpose

Linear is used as the external control panel for the AI development harness.

The user can send instructions from outside the development environment by creating or commenting on Linear issues.

The harness reads Linear issues and runs each role through the dispatcher (`run_worker.sh`) to the
worker configured for that role in `config/worker_roles.json`, then reports progress back to Linear.

## Basic Flow

```text
User
  ↓
Linear issue / comment
  ↓
runner → run_auto.sh (script-driven role pipeline)
  ↓
for each role (task-check → decomposition → implementation → verification → acceptance → github → linear-report):
    run_worker.sh <role> → worker per config/worker_roles.json chain (codex / claude / antigravity)
  ↓
Linear progress / completion comment
```

## User Rule

The user only needs to write instructions in Linear.

The user does not need to mention any worker CLI (Codex / Claude / Antigravity).

Examples:

```text
宅配ボックス一覧画面を作成してください。
```

```text
この issue を優先して対応してください。
```

```text
外出中なので、進捗だけコメントしてください。
```

```text
画面表示まで確認して、問題があれば修正してください。
```

## Issue Title Convention

Recommended title prefixes (for parent / classification context):

```text
[PLAN]      計画・設計
[IMPLEMENT] 実装
[DEBUG]     デバッグ
[REVIEW]    レビュー
[URGENT]    優先対応
[QUESTION]  確認依頼
```

Note: Generated child Issues use feature-outcome titles (e.g. `...を追加する`), not these process prefixes.

## Status Convention

```text
Backlog     未確認
Todo        認識済み
In Progress 作業中
In Review   確認待ち
Blocked     停止中
Done        完了
```

## Claude Code Work Policy

Claude Code must:

1. Read the issue
2. Read the latest comments
3. Identify the requested outcome
4. Define acceptance criteria
5. Decide whether worker tools are needed
6. Execute implementation or verification
7. Post progress back to Linear
8. Mark issue as Done only after verification

## Worker Tool Policy

Each role is dispatched to the worker configured in `config/worker_roles.json` (priority chain):

```text
codex        : verification / task-check / debugging worker (default)
antigravity  : implementation worker (default)
claude       : decomposition / acceptance / github / linear-report worker (default)
```

Roles are assigned individually and can be rerouted per issue from Linear
(`workers: role=worker`). The user does not interact with these tools directly.

## Progress Comment Template

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

## Completion Comment Template

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
