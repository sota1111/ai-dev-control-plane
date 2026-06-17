検証完了しました。`docs/ai/60_worker_codex_report.md` に指定フォーマットでレポートを書きました。

結果:
- PLAN終端状態の文書整合性: 問題なし
- 変更範囲: `CLAUDE.md`, `prompts/claude/auto_run.md`, `docs/ai/60_worker_codex_report.md` のみ
- `npm run lint`: PASS
- `npm test`: PASS（15 suites / 217 tests）

Next Action: `READY_FOR_REVIEW`
 as PR -> merge -> `Done`, with the PLAN exception scoped away from IMPLEMENT/FIX/DEBUG/DOC work. Markdown headings, blockquotes, lists, and numbering remain structurally coherent.

## Changed Files
- `docs/ai/60_worker_codex_report.md` — wrote this verification report; no policy-doc fix applied

## Commands Run
- `git diff --name-status main...HEAD` — PASS, no committed diff output
- `git diff --name-status main` — PASS, working tree changes limited to `CLAUDE.md`, `prompts/claude/auto_run.md`, and `docs/ai/60_worker_codex_report.md`
- `git diff -- prompts/claude/auto_run.md CLAUDE.md docs/ai/50_worker_gemini_report.md docs/ai/60_worker_codex_report.md` — PASS, reviewed documentation/report diffs only
- `rg -n "PLAN|PR|merge|Done|In Review|Quality Gate|GitHub Operations|PR MANDATORY|terminal state|Termination Conditions" prompts/claude/auto_run.md CLAUDE.md` — PASS, reviewed relevant cross-file statements
- `npm run lint` — PASS, exit 0
- `npm test` — PASS, exit 0; 15 test suites passed, 217 tests passed

## Acceptance Criteria
- [x] PLAN タスクが In Review で停止し、自動 merge/Done されないことが文書上明確
- [x] 実装系タスクの従来フロー（PR→merge→Done）が維持されている
- [x] auto_run.md と CLAUDE.md の記述が整合している（矛盾なし・Markdown崩れなし）
- [x] 変更が対象ファイル（auto_run.md / CLAUDE.md / docs配下の報告）に限定されている

## Risks
`git diff main...HEAD` produced no committed diff, so verification also checked the working tree diff against `main`. The working tree scope is valid for this docs-only change.

## Next Action
READY_FOR_REVIEW
