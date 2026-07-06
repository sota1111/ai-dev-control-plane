# Tasks — SOT-1558（分解不要: 親 SOT-1556 の分解済み子 Issue を単一作業単位として実装）

分解判断: 不要。単一 feature（acceptance 強化）で、対象ファイル群（workerRoles.ts / worker_roles.json /
run_auto.sh / prompts/roles/*.md / 70_acceptance_check.md）が密結合し 1 PR にまとまる。SOT-1558 自体が既に
親 SOT-1556 から分解済みのレバーであり、更なる子 Issue 化は overhead > value。
Task type: IMPLEMENT（PR → merge → In Review）。Repository: `/workspaces/ai-dev-control-plane`。
Branch: feat/sot-1556-loop-engineering-improvements（親と同一 feature ブランチ）。

## 実装タスク（順序: 1 → 3 → 2、親 SOT-1556 指示に従う）

### 1. doer/checker 分離 ＋ NOT_REQUIRED ピン留め限定
- [ ] `src/lib/workerRoles.ts` に doer/checker 分離ロジックを追加。acceptance ロールは直前に実装したワーカー
      とは別ワーカー／別セッションで走ることを既定にする（実装ワーカーと同一なら別ワーカーへ回す/別セッション化）。
- [ ] `config/worker_roles.json` の acceptance チェーンを実装チェーンと意図的に食い違わせる（先頭が実装 primary と
      別ワーカーになるように）。
- [ ] `scripts/ai/run_auto.sh` の SOT-1555 NOT_REQUIRED ピン留めを非コード生成タスク（DOC/REVIEW/PLAN/QUESTION/
      SECURITY-scan/純調査）限定に制限。IMPLEMENT/FIX/DEBUG では acceptance を別コンテキストに保つ（ピンしない）。

### 3. 実動作検証（snapshot/E2E）を acceptance の標準ステップ化
- [ ] `prompts/roles/acceptance.md` / `prompts/roles/verification.md` に、既存 snapshot ラベル導線 ＋ e2e/Playwright
      モックハーネスを標準ステップとして組み込み、after スクリーンショット ＋ 主要導線 E2E を受け入れ証跡として要求。
- [ ] repo 種別・`docs/screenshots/` 有無で UI/非UI を判定し、バックエンド/ライブラリは E2E 不要とする。
- [ ] `docs/ai/70_acceptance_check.md` 様式を規定。

### 2. 機械可読 `## Acceptance: PASS|FAIL` ゲート化
- [ ] acceptance レポートに `## Acceptance: PASS|FAIL`（criteria 単位の [x]/[ ]）を必須化。
- [ ] `scripts/ai/run_auto.sh` の acceptance ゲートが自然文でなくこの行を機械的に読むよう改修。

### 検証 / gate
- [ ] `src/lib/workerRoles.ts` の doer/checker 分離ロジックの単体テスト。
- [ ] ピン留め条件（NOT_REQUIRED 限定）のテスト。
- [ ] 機械可読 PASS/FAIL ゲート読取の検証。
- [ ] 既定挙動の非回帰（非 UI repo は E2E 不要、既存判定が壊れない）。
- [ ] lint / typecheck / test green。

## Next Action: READY_FOR_REVIEW（実装ロールへ）
