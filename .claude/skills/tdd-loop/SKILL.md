---
name: tdd-loop
description: Test-first iteration — write a failing test that pins the intended behavior, make it pass with the minimal change, then refactor, repeating per acceptance criterion. Low priority — applies only inside a Claude Code session, since the primary implementation workers are Antigravity/Codex.
---

# tdd-loop

Thin entry point for a **test-first (red → green → refactor) iteration** when Claude itself implements.

> **Claude-session only, limited applicability.** `.claude/skills` fire ONLY in a Claude Code session.
> In this harness the primary implementation workers are **Antigravity/Codex** (see CLAUDE.md → Worker
> Dispatch), so this skill applies only when Claude implements directly (e.g. the Fallback Policy).
> It is intentionally low priority and does not override the delegation rules.

## Canonical sources (do not duplicate their logic)
- **CLAUDE.md → "Quality Gate Criteria"** — the test/lint/typecheck gate every change must pass.
- **`real-action-acceptance` skill** — confirm the final behavior for real once tests are green.
- The target repo's own test runner (e.g. `npm test`, `flutter test`, `pytest`) — the source of truth
  for how tests run in that project.

## Loop (per acceptance criterion)
1. **Red** — write the smallest test that fails for the missing/incorrect behavior.
2. **Green** — make the minimal change so the test passes; do not add unrelated scope.
3. **Refactor** — clean up while keeping tests green.
4. Repeat for the next criterion; finish with `real-action-acceptance` for real-behavior confirmation.

## Out of scope
No PR/merge here. When work is delegated, implementation stays with Antigravity, verification/fixes with
Codex — this skill does not change that routing.
