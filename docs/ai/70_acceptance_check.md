# Acceptance Check — TEMPLATE (SOT-1558 様式)

This is the canonical format the **acceptance** role fills in each run (it overwrites this file with the
target issue's actual check). It pairs the human-readable evidence with the machine-readable
`## Acceptance: PASS|FAIL` line that `run_auto.sh` reads directly. Keep the section headings.

---

# Acceptance Check — <ISSUE-ID>（<short title>）

対象: `<target repo path>`, branch `<feat/...>`
コミット: `<sha> <commit subject>`

## Acceptance: PASS | FAIL
<!-- REQUIRED machine-readable verdict. run_auto.sh reads this line, not the prose below.
     PASS only when every criterion is [x] AND (UI repo) real-action verification passed. -->

## 受け入れ条件の判定
<!-- one row per acceptance criterion from docs/ai/40_acceptance.md -->
- [x] **<criterion 1>** — evidence: `<file:line>` / test `<name>` / observed behavior. **pass**
- [ ] **<criterion 2>** — not met: <why>. → loops back to implementation.

## 実ユーザー動作検証（SOT-1558）
<!-- UI repo (has e2e harness and/or docs/screenshots/, or change touches a visible screen): REQUIRED.
     Backend/library/doc-only repo: write "N/A（非 UI repo: e2e ハーネス無し / docs/screenshots 無し）". -->
- E2E（主要導線）: `<npm run e2e / project equivalent>` → <pass/fail per flow>.
- After スクリーンショット: `<docs/screenshots/<file> @ <sha>>` or "該当画面なし".

## 意図せぬ / スコープ外変更のチェック
- <confirm the diff is limited to the planned scope; list anything outside it and justify or reject.>

## 検証サマリ（60_worker_codex_report.md より）
- `npm run lint` exit <n> / `npm run typecheck` exit <n> / `npm test` <pass/fail counts>.
- e2e: <result or "N/A（非 UI repo）">。

## Next Action: READY_FOR_REVIEW | NEEDS_DEBUG | NEEDS_USER_INPUT | BLOCKED
