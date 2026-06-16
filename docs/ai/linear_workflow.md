# Linear Workflow for Claude Code AI Harness

## Purpose

Linear is used as the external control panel for the AI development harness.

The user can send instructions from outside the development environment by creating or commenting on Linear issues.

Claude Code reads Linear issues, plans the work, optionally uses Gemini CLI and Codex CLI internally, and reports progress back to Linear.

## Basic Flow

```text
User
  ↓
Linear issue / comment
  ↓
Claude Code
  ↓
Plan / Design / Task split
  ↓
Gemini CLI, if implementation is needed
  ↓
Codex CLI, if debugging or verification is needed
  ↓
Claude Code review
  ↓
Linear progress / completion comment
```

## User Rule

The user only needs to write instructions in Linear.

The user does not need to mention Gemini CLI or Codex CLI.

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

Claude Code may internally use:

```text
Gemini CLI:
  Implementation worker

Codex CLI:
  Debugging and verification worker
```

The user does not interact with these tools directly.

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
