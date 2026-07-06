---
name: session-retro
description: At the end of a session, write out what was learned — durable facts and hard-won gotchas — to the failure-log and to persistent memory, so the next session does not re-investigate or repeat mistakes. Use before wrapping up non-trivial work.
---

# session-retro

Thin entry point for **end-of-session knowledge capture**. Distills the session's learnings into the
existing failure-log / memory stores instead of letting them evaporate.

> **Claude-session only.** `.claude/skills` fire ONLY in a Claude Code session; Codex / Antigravity legs
> never trigger skills. Persistent memory (`~/.claude/.../memory/`) is likewise a Claude-session
> facility. Pairs with the parent Issue's failure-log child.

## Canonical sources (route to them — do not re-invent the format)
- **Persistent memory** — `MEMORY.md` index + one fact per topic file, with the frontmatter schema
  described in the project memory instructions. Update an existing file rather than duplicating.
- **failure-log** — the parent Issue's failure-log store (record what failed, the root cause, and how to
  avoid it next time). Link related memories with `[[name]]`.

## Procedure
1. Review the session: what was non-obvious, what failed and why, what the correct approach turned out
   to be (decisions, gotchas, dead ends to not repeat).
2. For each durable learning, **update or create** one memory file (one fact per file) and add/adjust its
   one-line pointer in `MEMORY.md`. Prefer updating an existing file over creating a duplicate.
3. Record failures + root cause + avoidance into the failure-log so future runs don't re-investigate.
4. Skip anything the repo already records (code structure, git history, CLAUDE.md) or that only mattered
   to this one conversation.

## Out of scope
No implementation, no PR. Only captures learnings to the existing stores.
