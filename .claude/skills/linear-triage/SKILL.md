---
name: linear-triage
description: Triage a Linear Issue — classify its task type (PLAN/IMPLEMENT/FIX/DEBUG/DOC/REVIEW/SECURITY) and judge whether to decompose it into child Issues. Use at the start of processing a new/reopened Issue, before implementation. A thin entry point over the issue-classifier agent and the CLAUDE.md classification/decomposition policy — it does NOT implement anything.
---

# linear-triage

Thin entry point for **Issue classification + decomposition judgment**. This skill does not add new
logic; it routes to the canonical sources of truth and keeps them the single place the rules live.

> **Claude-session only.** `.claude/skills` fire ONLY in a Claude Code session. The Codex / Antigravity
> worker legs never trigger skills — the equivalent policy for those legs lives in the `task-check` role
> prompt (`prompts/roles/task-check.md`) and CLAUDE.md. Do not duplicate the rules here.

## Canonical sources (do not re-state their logic — read/call them)
- **`.claude/agents/issue-classifier`** — the actual classifier. Delegate the "what type + decompose?"
  decision to it (via the `issue-classifier` agent) and use its JSON output.
- **CLAUDE.md → "Issue Classification Policy"** — task types and their primary workers.
- **CLAUDE.md → "Child Issue Registration Policy"** — when to decompose, naming, description template,
  registration procedure (inherit parent Project + Priority).

## Procedure
1. Read the Linear Issue: status, labels, latest comments, description, acceptance criteria.
2. **Classify** by delegating to the `issue-classifier` agent (Agent tool) — do not re-implement its
   rules. Post `タスク分類: <TYPE>` / `担当AI: <TYPE>:<WORKER>` as a Linear comment.
3. **Judge decomposition** per CLAUDE.md's Child Issue Registration Policy. Most Issues do NOT need it.
   Post `分解判断: 必要 / 不要` + a one-line reason as a Linear comment.
4. If decomposing: create 2–5 child Issues as sub-issues, each inheriting the parent's **Project** and
   **Priority** (see the registration procedure in CLAUDE.md). Otherwise treat the parent as the single
   work unit.

## Out of scope
No implementation, no git/PR. Hand off to implementation once triaged.
