# Acceptance Criteria — SOT-1558

acceptance を別コンテキスト完了判定 ＋ 機械可読 PASS/FAIL ＋ 実動作検証に強化する
（loop engineering 提案レバー1、親 SOT-1556）

## 受け入れ条件

- [ ] IMPLEMENT/FIX/DEBUG では acceptance が実装ワーカーと別コンテキスト（別ワーカー／別セッション）で走る。
- [ ] SOT-1555 の NOT_REQUIRED ピン留めは非コード生成タスク（DOC/REVIEW/PLAN/QUESTION/SECURITY-scan/純調査）
      限定にし、IMPLEMENT/FIX/DEBUG では acceptance を別コンテキストに保つ。
- [ ] acceptance レポートが機械可読の `## Acceptance: PASS|FAIL`（criteria 単位の [x]/[ ]）を必須出力し、
      `run_auto.sh` のゲートが自然文でなくこの行を機械的に読む。
- [ ] UI を持つ target repo では実ユーザー動作検証（after スクリーンショット ＋ 主要導線 E2E/Playwright）が
      acceptance の標準ステップになる。バックエンド/ライブラリ（`docs/screenshots/` 無し等 repo 種別）は E2E 不要。
- [ ] 既定挙動の非回帰：非 UI repo は E2E 不要、既存パイプラインの成功/停止判定が壊れない。

## 検証

- `src/lib/workerRoles.ts` の doer/checker 分離ロジックの単体テスト（acceptance が直前実装ワーカーと別に選ばれる）。
- ピン留め条件（NOT_REQUIRED 限定＝非コード生成タスクのみピン、IMPLEMENT/FIX/DEBUG はピンしない）のテスト。
- 機械可読 `## Acceptance: PASS|FAIL` ゲート読取の検証。
- lint / typecheck / test green。
