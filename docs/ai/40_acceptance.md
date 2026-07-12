# Acceptance Criteria — SOT-1594 「分割を戻す」ボタンのバグ（REOPEN #4）

Repository: /workspaces/toddler-private-rag（backend, FastAPI + pytest）
種別: FIX (Bug) / ラベル: Bug

実フロー: 1. 文字起こし → 2. 写真からタスク分解 → 3. 締切逆算エージェントによるタスク分割 (n/N)。
「分割を戻す」は手順3のみ取り消し、手順2完了・締切エージェント起動前の状態へ戻す。

## AC（受け入れ条件）
- [ ] AC1: 実フロー（手順2 `build_task_drafts` → 手順3 `run_submission_agent` で締切分割 (1/N)…(N/N) 作成）
      を経た後、いずれかの (n/N) 分割タスクで「分割を戻す」を押すと、締切グループが1タスクへ統合される。
- [ ] AC2: 復元された content は **手順2（写真からタスク分解済み・締切エージェント起動前）のタスク本文**
      と一致する。締切調査の付随タスク本文（調査結果の羅列）にならない。
- [ ] AC3: 復元された content は **元書類（写真）の生の文字起こし全文**にならない。
- [ ] AC4: 復元された title は **締切分割前タスク（アンカー）のタイトル**。写真書類のタイトル
      （例「7月のおたよりと七夕祭りのお知らせ」）にならない。
- [ ] AC5: 「分割を戻す」は押下タスクの締切グループ (n/N) 群のみを対象にし、手順2で分割された他タスク・
      手順2の他書類タスクは消えない（PR #398 の締切グループ限定スコープを退行させない）。
- [ ] AC6: draft 版（`/drafts/{id}/revert-split`）・本登録版（`/{id}/revert-split-registered`）の両方で成立。
- [ ] AC7: **実フローを通しで再現する回帰テスト**（合成 anchor でなく `build_task_drafts` →
      `run_submission_agent` → revert を実エンドポイント経由）を追加し、AC2/AC3/AC4 を pin する。
- [ ] AC8: backend フルスイート pass（lint/typecheck 相当含む）、coverage floor（70%）維持。
- [ ] AC9: 現行 main のコードで再現テストが通る場合、残る差分は本番未デプロイである旨を Human Check に明示。

## スコープ外
- frontend 変更（ナビゲーション等は SOT-1596 で対応済み）。
- 締切分割・締切調査エージェント本体のロジック変更。
