# Plan — SOT-1558

## 要件解釈（1–2行）
acceptance（完了判定）を「別コンテキスト・別モデル」の doer/checker 分離で行い、受け入れ判定を機械可読
`## Acceptance: PASS|FAIL` にゲート化し、UI を持つ target repo では snapshot/E2E の実動作検証を受け入れ証跡に
標準ステップとして組み込む。（loop engineering レバー1、親 SOT-1556）

## タスク種別
IMPLEMENT（config/worker_roles.json ＋ src/lib/workerRoles.ts ＋ scripts/ai/run_auto.sh ＋ prompts/roles/*.md ＋
docs 様式の密結合な複数ファイル変更 + test）。Implementation REQUIRED。

## スコープ
- doer/checker 分離: acceptance ロールを直前実装ワーカーとは別ワーカー／別セッションで走らせるのを既定化
  （`src/lib/workerRoles.ts` の選択ロジック、`config/worker_roles.json` の acceptance チェーンを実装チェーンと
  意図的に食い違わせる）。SOT-1555 の NOT_REQUIRED ピン留めを非コード生成タスク限定に制限し、IMPLEMENT/FIX/DEBUG
  では acceptance を別コンテキストに保つ（`scripts/ai/run_auto.sh`）。
- 機械可読化: acceptance レポートに `## Acceptance: PASS|FAIL`（criteria 単位の [x]/[ ]）を必須化し、
  `run_auto.sh` のゲートが自然文でなくこの行を直接読む。曖昧な自然文完了宣言を排除。
- 実動作検証: snapshot ラベル導線 ＋ e2e/Playwright モックハーネスを acceptance の標準ステップに組み込み、
  after スクリーンショット ＋ 主要導線 E2E を受け入れ証跡として要求（repo 種別・`docs/screenshots/` 有無で判定）。
  バックエンド/ライブラリは E2E 不要。
- prompts: `prompts/roles/acceptance.md` / `prompts/roles/verification.md` に実動作検証（snapshot/E2E）を標準ステップ化、
  `docs/ai/70_acceptance_check.md` 様式を規定。

## 実装順序（親 SOT-1556 指示）
1（doer/checker 分離＋ピン留め限定）→ 3（実動作検証標準ステップ化）→ 2（機械可読 PASS/FAIL ゲート）。

## 想定 commit
- `feat(SOT-1558): make acceptance a separate-context checker with machine-readable PASS/FAIL`
- `feat(SOT-1558): integrate snapshot/e2e real-action verification into acceptance`

## 分解判断
不要（30_tasks.md 参照）。単一 feature（acceptance 強化）で対象ファイル群が密結合、1 PR にまとまる。

## Next Action: READY_FOR_REVIEW（実装ロールへ）
