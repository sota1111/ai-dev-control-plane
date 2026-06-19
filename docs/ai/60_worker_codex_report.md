# Worker Report — SOT-875 task check

## Summary
Initial task check for SOT-875 「権限委譲時のlinear文言」.
Codex CLI was NON-RESPONSIVE (usage-limit cooldown, run_codex.sh exited 75), so Claude Code
performed this task check directly under the Worker Non-Response Fallback Policy.

SOT-875 is actionable. The requested change: the Linear classification/delegation comment
currently records *why* work was delegated (`理由: <one-line reason>`); change it to record the
**assigned AI** in `<TASK_TYPE>:<WORKER>` form, e.g. `IMPLEMENT:GEMINI`. This is a DOC-only
wording change to the instruction templates (no code generates these comments — Claude Code
follows the templates).

## Changed Files
- none (task check only). Candidate files that WOULD change:
  - `CLAUDE.md` lines 645–648 — "Classification Comment" template
  - `prompts/claude/auto_run.md` lines 83–86 — "Issue Classification" template
  - NOT to change: `CLAUDE.md:490-492` and `auto_run.md:147-149` are the *decomposition judgment*
    template (`分解判断` + `理由`), unrelated to delegation wording — keep as-is.

## Commands Run
- `TARGET_REPO=/workspaces/ai-dev-control-plane bash scripts/ai/run_codex.sh` → exit 75
  (`CODEX_COOLDOWN_ACTIVE: codex usage limit until epoch 1782000900`) — non-responsive.
- `grep -rn "推奨worker|タスク分類|理由|権限委譲" CLAUDE.md prompts/ scripts/` — wording lives only in
  the two instruction templates above; no runtime string-builder posts these comments.

## Acceptance Criteria
- [x] Located where delegation/classification wording is generated (instruction templates only)
- [x] Determined change is DOC-only (no code path)
- [x] Recommended task type DOC + decomposition 不要

## Risks
- Minor design ambiguity in exactly how to restructure the 3-line block. Chosen: keep `タスク分類`,
  replace `推奨worker` + `理由` with a single `担当AI: <TYPE>:<WORKER>` line (例: IMPLEMENT:GEMINI),
  dropping the "why" per the user's instruction.

## Next Action
READY_FOR_REVIEW
