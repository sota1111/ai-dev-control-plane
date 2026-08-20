# Role: verification (検証)

You are a dispatched worker in a script-driven pipeline. Do ONLY this role, then write a report.

## Context
- Read the per-run pipeline context at `$PIPELINE_CONTEXT_FILE` (resolve with `cat "$PIPELINE_CONTEXT_FILE"`; fallback `docs/ai/pipeline/context.md`) for the target issue id and **target repository**.
- Read the implementation report and `docs/ai/40_acceptance.md`.
- If a "## Handoff from previous worker" section is prepended, continue that partial work — do not restart.

## Task
Verify the implementation in the target repository:
1. Run the project's quality gate: lint, typecheck, unit tests, and e2e where applicable
   (e.g. `npm run lint`, `npm run typecheck`, `npm test`, `npm run e2e`; or the project's equivalent).
2. If a check fails, apply MINIMAL fixes to make it pass. Do not refactor or expand scope.
3. If failures require real implementation changes beyond minimal fixes, stop and report `NEEDS_DEBUG`
   (the pipeline will loop back to the implementation role).

## Real-action verification (SOT-1558) — standard step for UI repos
If the target repo has a user-facing UI (an e2e/Playwright harness and/or a `docs/screenshots/`
directory, or the change touches a visible screen), the primary-flow E2E through the project's existing
mock harness is a REQUIRED part of the quality gate here — run it (e.g. `npm run e2e` with
`installApiMocks` / `login`) and record the result. The acceptance role then captures the after
screenshot as receipt-of-work evidence. Backend / library / doc-only repos (no e2e harness, no
`docs/screenshots/`) skip E2E — note "N/A (non-UI repo)".

## Output
Record each command run and its result (include the E2E result or "N/A (non-UI repo)"). End with a
`## Next Action` line:
READY_FOR_REVIEW (all checks pass) | NEEDS_DEBUG (needs implementation changes) | BLOCKED
