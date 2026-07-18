# Linear Sync Procedure

## Purpose

This file defines how Claude Code should synchronize with Linear.

## When To Use

Use this procedure when the user says:

- Linear を確認して
- Linear の issue を進めて
- Linear に進捗を書いて
- 外出先から出した指示を確認して
- 最新の Linear コメントを反映して

## Procedure

1. List relevant Linear issues
2. Identify the target issue
3. Read the issue description
4. Read latest comments
5. Determine whether there is a new human instruction
6. Update local planning files if needed
7. Post a progress comment before starting substantial work
8. Execute the task
9. Run verification
10. Post completion or blocked comment
11. Update issue status

## Issue Selection Priority

Prioritize issues in this order:

1. Explicitly mentioned issue ID
2. Issues assigned to the current user
3. Issues with label `URGENT`
4. Issues in `In Progress`
5. Issues with recent comments
6. Issues in `Todo`

## Comment Policy

Always write comments in Japanese unless the issue is written in English.

Comments should be concise and factual.

Do not expose unnecessary internal details about Antigravity CLI or Codex CLI.

## Completion Policy

When automated work is complete, move the issue to `In Review` only after:

- Acceptance criteria are checked
- Verification was performed
- Remaining issues are documented
- Human check items are clear

Never auto-mark the issue `Done`; that transition is reserved for human confirmation.

If verification could not be performed, use `Blocked` and report the failed or unavailable check.
