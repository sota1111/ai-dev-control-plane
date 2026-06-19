# Worker Report

## Summary
Initial task check for SOT-827. **Codex CLI was non-responsive** (usage-limit cooldown,
`run_codex.sh` exit 75: "CODEX_COOLDOWN_ACTIVE ... until epoch 1782000900"). Per the Worker
Non-Response Fallback Policy, Claude Code performed the task check directly.

Findings:
- **Issue is actionable.** Status In Progress, no terminal state, no comments, no missing prereqs.
  Target of the feature is this repo (ai-dev-control-plane) itself.
- **Current repo selection is manual.** Workers run against `TARGET_REPO` (env var) — see
  `scripts/ai/run_gemini.sh:33` (`--include-directories $TARGET_REPO`) and
  `scripts/ai/run_codex.sh:36` (`cd $TARGET_REPO`). `TARGET_REPO` is chosen ad-hoc by Claude Code
  from context/memory; there is **no** config mapping a Linear project to a repository.
- **No existing mapping mechanism.** `config/` only has `auth/apps.json`; `src/lib/` and `src/config/`
  have no project→repo resolver.
- **Integration points:** `src/runner.ts` `triggerRun()` (line ~1306) spawns `run_auto.sh` with
  `WEBHOOK_ISSUE_ID` env; `run_auto.sh` injects the "Webhook Single-Issue Mode" preamble into the
  Claude prompt. The runner already calls Linear GraphQL (`linearQuery`), so it can fetch the issue's
  project name and inject a resolved target repo into the prompt env. The webhook handler
  (`src/webhook-server.ts`) does not currently read `body.data.project`.

## Changed Files
- none (read-only task check; Claude fallback)

## Commands Run
- `bash scripts/ai/run_codex.sh` → exit 75 (CODEX_COOLDOWN_ACTIVE; non-responsive)
- `grep -rn TARGET_REPO scripts/ src/` ; read of run_auto.sh / runner.ts / webhook-server.ts / package.json

## Acceptance Criteria
- [x] Issue confirmed actionable
- [x] Current repo-selection mechanism documented
- [x] Integration point(s) for a project→repo resolver identified

## Risks
- Linear project name strings must match config keys exactly; need a clear "unknown project" path.
- Wiring into the live webhook/runner path touches the autonomous loop — must be fail-open and covered by tests.

## Next Action
READY_FOR_REVIEW
