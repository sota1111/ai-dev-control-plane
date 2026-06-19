# Worker Report

> **FALLBACK NOTICE (Worker Non-Response Policy):** Codex CLI was non-responsive
> for this run. `scripts/ai/run_codex.sh` exited with the dedicated non-response
> code `75` due to an active usage-limit cooldown (`CODEX_COOLDOWN_ACTIVE` until
> epoch 1782000900, ~42h out). A retry against a multi-hour cooldown is futile, so
> per the Worker Non-Response Fallback Policy, Claude Code performed this initial
> task check AND the DOC change directly. All quality gates were still run.

## Summary

SOT-836 「Backlogを対応しない」— limit automated processing to Todo / In Progress.

Findings: the code-level scan/queue filters (`src/runner.ts`, `src/webhook-server.ts`,
`src/lib/schedulerCore.js`) already use `state.type in ["unstarted","started"]`, so the
Linear `backlog` type is **already excluded** in code. The remaining gap was the
orchestration prompt `prompts/claude/auto_run.md`, which listed `Backlog` as a target
status and in the sort order, plus two docs that incorrectly described `unstarted` as
covering Backlog. Fixed the prompt and the docs; no code change needed.

## Worker Non-Response Disclosure
- Non-responsive worker: Codex CLI
- Detected failure mode: usage-limit cooldown (CODEX_COOLDOWN_ACTIVE, fixed epoch ~1.7 days out)
- Action: Claude Code fallback performed the task check and the DOC change directly.

## Changed Files
- `prompts/claude/auto_run.md` — removed `Backlog` from target statuses and sort order; added explicit "do not process Backlog" note
- `docs/webhook.md` — corrected scan target wording (`unstarted` = Todo only; Backlog excluded)
- `docs/scheduler.md` — corrected polling target wording (`unstarted` = Todo only; Backlog excluded)

## Commands Run
- `npm run lint` → exit 0 (pass)
- `npm run typecheck` → exit 0 (pass)
- `npm test` → exit 0 (25 suites, 329 tests passed)

## Acceptance Criteria
- [x] Backlog excluded from automated processing targets (prompt + docs)
- [x] Todo and In Progress remain in scope
- [x] Code-level filter confirmed already correct (no regression)
- [x] Quality gate green

## Risks
- Code filter was already correct; the change is prompt/doc wording only — low risk.

## Next Action
READY_FOR_REVIEW
