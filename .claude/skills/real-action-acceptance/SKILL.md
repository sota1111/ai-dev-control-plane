---
name: real-action-acceptance
description: Confirm acceptance by real behavior, not tests alone — run the app / feature and observe it actually working, then check each acceptance criterion against the real result. Use after implementation, before declaring an Issue met. A thin entry point over the verify skill and the acceptance-checker agent.
---

# real-action-acceptance

Thin entry point for **acceptance confirmation by real behavior**. Green unit tests are necessary but
not sufficient: also exercise the actual behavior. This skill routes to existing verification tooling
rather than re-implementing it.

> **Claude-session only.** `.claude/skills` fire ONLY in a Claude Code session. The Codex / Antigravity
> verification legs never trigger skills — for those legs the equivalent lives in the `verification` /
> `acceptance` role prompts and CLAUDE.md's Quality Gate. Keep the rules there, not duplicated here.

## Canonical sources (use them — do not re-state their logic)
- **`verify` skill** — launch the app and observe behavior (run the feature, confirm the fix works).
- **`.claude/agents/acceptance-checker`** — compare the Issue's acceptance criteria against the actual
  git diff / changed files and return only the UNMET criteria.
- **CLAUDE.md → "Quality Gate Criteria"** — the lint/typecheck/test/e2e/diff gate.

## Procedure
1. Run the standard gate (lint / typecheck / test, e2e if applicable) — see CLAUDE.md Quality Gate.
2. **Observe real behavior** via the `verify` skill: actually run the app/feature and check it does what
   the Issue asked (not just that tests pass).
3. **Check criteria** via the `acceptance-checker` agent (Agent tool): pass the acceptance criteria +
   the diff; collect the unmet ones.
4. If any criterion is unmet or the real behavior differs from the spec, loop back to implementation
   (NEEDS_DEBUG) rather than declaring done.

## Out of scope
No implementation, no PR/merge. Only verifies and reports met/unmet.
