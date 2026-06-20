# Worker Report — SOT-875 task check (fallback wording fix)

## Summary
Initial task check + DOC edit for SOT-875「権限委譲時のlinear文言」(reopened Done → Todo).
Codex CLI was NON-RESPONSIVE (`run_codex.sh` exit 75, usage-limit cooldown until epoch
1782000900), so Claude Code performed this task check and the DOC edit directly under the
Worker Non-Response Fallback Policy. (This audit stays in this report file only, per the new rule.)

Latest human instruction (comment 2026-06-19T23:36): the fallback disclosure note posted to
Linear ("注: Codex CLI が…Worker Non-Response Fallback Policy に基づき…代行しました。") is
unnecessary; report only the result to Linear.

Root cause: `CLAUDE.md` "Worker Non-Response Fallback Policy" → "Disclosure / audit" rule
required recording the fallback "both in the relevant worker report file AND as a Linear comment".
Fix: record only in the worker report file; do not post the disclosure as a Linear comment.

## Changed Files
- `CLAUDE.md` — "Disclosure / audit" rule: fallback record goes to the worker report file only,
  Linear receives the work result only (no fallback disclosure comment).
- `prompts/claude/auto_run.md` — verified, no equivalent wording, unchanged.

## Commands Run
- `TARGET_REPO=/workspaces/ai-dev-control-plane bash scripts/ai/run_codex.sh` → exit 75 (cooldown)
- `grep -rn "Disclosure|代行|Fallback" CLAUDE.md prompts/` → mandate isolated to `CLAUDE.md` Disclosure rule

## Acceptance Criteria
- [x] Fallback disclosure note no longer mandated for Linear comments
- [x] Audit trail preserved in the worker report file
- [x] Linear receives result-only reporting on fallback
- [x] No equivalent wording left in `prompts/claude/auto_run.md`

## Risks
- None. Audit is preserved locally; only the human-facing Linear comment is simplified.

## Next Action
READY_FOR_REVIEW
