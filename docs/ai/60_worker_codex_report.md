# Worker Report

## Summary
Task check + verification for **SOT-935「リファクタリング」** (脆弱性見直し＋リファクタ; plan then implement).

**Worker non-response disclosure (audit sink):** the initial task check + verification were delegated
to Codex CLI (`scripts/ai/run_codex.sh`) per policy, but Codex was **non-responsive** — exit code **75**
(`CODEX_COOLDOWN_ACTIVE`, usage-limit cooldown until epoch 1782000900, ~7h out). Retrying is futile.
Gemini CLI is a known permanently-ineligible tier (exit 75 IneligibleTierError). Per the Worker
Non-Response Fallback Policy, Claude Code performed the task check, implementation, and verification
directly. All Quality Gates were applied identically.

**Verdict: SOT-935 is actionable.** Concrete vulnerability identified and fixed:
`verifyLinearSignature` compared the HMAC-SHA256 signature with `===` (non-constant-time) → timing
side-channel that can leak the expected signature byte-by-byte. Fixed via constant-time comparison.

## Changed Files
- `src/lib/timingSafeEqual.ts` — new `timingSafeEqualStr(a, b)` helper using `crypto.timingSafeEqual`
  (type-guards non-strings, returns false on length mismatch without throwing).
- `src/webhook-server.ts` — `verifyLinearSignature` now uses `timingSafeEqualStr(signature, expected)`
  instead of `signature === expected`.
- `src/__tests__/timingSafeEqual.test.ts` — new unit tests (equal, unequal-same-length,
  different-length no-throw, empty, non-string inputs).
- `docs/ai/10_plan.md` — SOT-935 section: vulnerability finding + scoped refactor plan
  (runner.ts god-file split deferred as follow-up; not auto-rewritten while the runner is live).

## Commands Run
- `npm run lint` → exit 0
- `npm run typecheck` (tsc --noEmit) → exit 0
- `npm test` → exit 0 (Test Suites: 30 passed, Tests: 439 passed, incl. new timingSafeEqual suite)
- `bash scripts/ai/run_codex.sh` → exit 75 (cooldown; fallback to Claude Code)

## Acceptance Criteria
- [x] 脆弱性の見直し — HMAC `===` timing side-channel identified.
- [x] 修正実装 — constant-time `crypto.timingSafeEqual` comparison applied to Linear webhook verify.
- [x] テスト — unit tests for the constant-time comparison helper.
- [x] Plan して実装 — plan recorded in 10_plan.md, then implemented in the same PR.

## Risks
- The large `src/runner.ts` god-file (~2700 lines) is the main "継ぎ接ぎ" factor but is NOT auto-rewritten
  here — doing so on a live runner is high-risk. Recommended as a separate, responsibility-scoped
  follow-up (per-module small PRs). Documented in 10_plan.md.
- Unrelated untracked file `scripts/ai/mobile_check.mjs` (stray from an earlier SOT-856 mobile run) is
  intentionally NOT committed.

## Next Action
READY_FOR_REVIEW
