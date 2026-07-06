# Acceptance Check — SOT-1558（acceptance separate-context checker）

対象: `/workspaces/ai-dev-control-plane`, branch `feat/sot-1558-acceptance-separate-context`
コミット: `64abf52 feat(SOT-1558): make acceptance a separate-context checker with machine-readable PASS/FAIL`

## 受け入れ条件の判定

- [x] **IMPLEMENT/FIX/DEBUG では acceptance が実装ワーカーと別コンテキスト（別ワーカー／別セッション）で走る。** — `config/worker_roles.json:5-7` sets implementation primary to `claude` and acceptance primary to `codex`; `scripts/ai/run_auto.sh:311-318` records the actual implementation winner in `PIPELINE_IMPL_WORKER`; `scripts/ai/run_worker.sh:59-64` and `scripts/ai/run_worker.sh:81-85` move that worker to the back of the acceptance chain. Unit coverage: `src/__tests__/workerRoles.test.ts:210-279`.
- [x] **SOT-1555 の NOT_REQUIRED ピン留めは非コード生成タスク限定にし、IMPLEMENT/FIX/DEBUG では acceptance を別コンテキストに保つ。** — `scripts/ai/run_auto.sh:323-336` only sets `PIPELINE_PINNED_WORKER` when task-check emits `## Implementation: NOT_REQUIRED`; otherwise code-building tasks proceed without pinning and use `PIPELINE_IMPL_WORKER` separation. `scripts/ai/run_worker.sh:77-85` gives the pin precedence over checker separation, making pin and separation mutually exclusive. Unit coverage includes pin/separation inverse behavior at `src/__tests__/workerRoles.test.ts:262-270`.
- [x] **acceptance レポートが機械可読の `## Acceptance: PASS|FAIL` を必須出力し、`run_auto.sh` のゲートがこの行を機械的に読む。** — `prompts/roles/acceptance.md:35-58` requires the machine-readable verdict; `docs/ai/70_acceptance_check.md` now uses this concrete report format; `scripts/ai/run_auto.sh:360-390` parses `^## Acceptance: PASS|FAIL` and loops on `FAIL` before falling back to `Next Action`.
- [x] **UI を持つ target repo では実ユーザー動作検証が acceptance の標準ステップになる。非 UI repo は E2E 不要。** — `prompts/roles/acceptance.md:21-33` requires E2E/screenshot evidence for UI repos and N/A for backend/library/doc-only repos; `prompts/roles/verification.md` also requires the same E2E decision in verification. This target repo has no `e2e` script, no Playwright/e2e harness, and no `docs/screenshots/`; therefore E2E is N/A for this run.
- [x] **既定挙動の非回帰：非 UI repo は E2E 不要、既存パイプラインの成功/停止判定が壊れない。** — `npm run lint`, `npm run typecheck`, `npm test`, and `bash -n scripts/ai/run_auto.sh scripts/ai/run_worker.sh` all pass. The acceptance gate remains backward-compatible when the `## Acceptance:` line is absent via the fallback at `scripts/ai/run_auto.sh:384-390`.

## Acceptance: PASS

## 実ユーザー動作検証（SOT-1558）

- E2E（主要導線）: N/A（非 UI repo: `package.json` has no `e2e` script; `find` found no Playwright/e2e harness and no `docs/screenshots/`）.
- After スクリーンショット: N/A（非 UI repo / visible screen changeなし）.

## 意図せぬ / スコープ外変更のチェック

- `git diff main...HEAD` is limited to worker role config, SOT-1558 pipeline shell logic, role prompts, acceptance template, SOT-1558 tests, and issue planning docs.
- Local uncommitted verification artifacts also exist (`docs/ai/60_worker_codex_report.md`, `src/__tests__/runner.test.ts`, `.claude/settings.local.json`, and experiment/benchmark files), but they are outside `main...HEAD` feature diff. The verification-time `runner.test.ts` change was a minimal env-isolation fix for this worker environment.

## 検証サマリ

- `npm run lint` → pass.
- `npm run typecheck` → pass.
- `npm test` → pass: 43 suites, 666 tests.
- `bash -n scripts/ai/run_auto.sh scripts/ai/run_worker.sh` → pass.
- e2e: N/A（非 UI repo）.

## Next Action: READY_FOR_REVIEW
