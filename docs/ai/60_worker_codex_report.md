# Worker Report

## Summary
SOT-790 verification ("アイドル時の自動drainを追加してcooldown明け後のキュー滞留を解消する").
Performed by **Claude Code fallback** because Codex CLI was non-responsive: `scripts/ai/run_codex.sh`
exited with the dedicated non-response code **75** (`CODEX_COOLDOWN_ACTIVE`: codex usage limit until
epoch 1782000900, ~63h out). A usage-limit cooldown is a hard time-gate, so per the Worker
Non-Response Fallback Policy Claude Code ran the Quality Gate directly.

Note: Gemini also produced a non-response exit 75 (false "empty report" — the run completed but its
output log contained 429-retry null bytes that tripped the script's emptiness check). The actual
implementation was written correctly; verified below.

## Changed Files
- none (verification only; implementation done by Gemini in `docs/ai/50_worker_gemini_report.md`)

## Commands Run
- `npm run lint` → exit 0
- `npm run typecheck` → exit 0 (tsc --noEmit, clean)
- `npm test` → exit 0 — **Test Suites: 23 passed, 23 total; Tests: 298 passed, 298 total**
  - includes the new `describe('periodic drain', ...)` suite (drains-when-idle, skip-when-locked,
    skip-when-cooldown, skip-when-no-due-item, re-entry guard, startPeriodicDrain unref).

## Findings
- `src/webhook-server.ts`: `QUEUE_DRAIN_INTERVAL_MS` (default 300000ms), `hasDueQueueItem()`,
  `runPeriodicDrainTick()` (guards: re-entry flag, `isLocked`, `getUsageLimitCooldownUntil() !== null`,
  due-item check), `startPeriodicDrain()` (unref'd interval, returns timer). Started only inside the
  `isMain` block after `app.listen`. New symbols exported for testability.
- Behavior is additive — existing webhook-completion drain (`finally→drainQueue`) and bootstrap drain
  are unchanged.
- Multi-drain safety: in-process re-entrancy guard `_periodicDrainRunning` + existing per-item
  `acquireLock()` inside `drainQueue`.

## Acceptance Criteria
- [x] runner cooldown 無し・適格キュー項目あり・新規 webhook 無しの状態でキューが自動drainされる
  （periodic interval が条件成立時に `drainQueue` を呼ぶ。テストで検証済み）
- [x] 周期 drain がロック中に多重起動しない（再入ガード＋`isLocked` skip。テストで検証済み）
- [x] lint / typecheck / test が pass

## Risks
- 既定5分間隔のポーリング。`loadQueue()` はファイル読込のみで軽量。負荷影響は無視可能。
- stale inflight reaper は本Issueでは未実装（Issueでも「任意/検討」）。必要なら別Issueで対応。

## Next Action
READY_FOR_REVIEW
