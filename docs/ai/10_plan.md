# 10_plan — SOT-1594 「分割を戻す」ボタンのバグ（REOPEN #4）

## 要件の解釈（人間コメント 03:33 / REOPEN #4）
実フロー: **1. 文字起こし → 2. 写真からタスク分解 → 3. エージェント（締切逆算）によるタスク分割 (n/N)**。
「分割を戻す」は **手順3だけを取り消し、手順2（写真からタスク分解）完了・締切エージェント起動前の状態**
へ戻す。現状は「締切エージェント起動後の状態」に戻ってしまうと報告されている。

## タスク種別 / スコープ
- 種別: **FIX (Bug)** — 単一バグの追加是正。
- スコープ: backend のみ（`backend/app/routers/info.py` / `backend/app/extraction.py` の
  revert-split 復元ロジック＋テスト）。frontend 変更なしを既定とする。
- 対象リポジトリ: `/workspaces/toddler-private-rag`。

## 実コードで確認した現状（task-check がコード確認済み）
- 締切エージェント `run_submission_agent`（`routers/info.py:728`）は手順3で **子（付随）タスクを新規作成**し、
  元の手順2タスク（=アンカー）には `repo.update(id, …)` で **`deadline_group_id` / `deadline_offset_days=0`
  / `deadline_base_date` の3メタデータだけ**を書き込む。**title/content は上書きしない**（`info.py:776-787`）。
  → アンカー（offset 0・非付随タスク）の content は原理上「手順2の状態」を保持しているはず。
- 復元は既に anchor 経由で実装済み: `_find_anchor_dict`（offset 0 の非付随タスクを選ぶ, `info.py:437`）→
  `merge_split_drafts_to_single(…, anchor=…)`（`extraction.py:1121`）が title/content をアンカーから復元し、
  生文字起こし（`source.content`）と一致する場合はフォールバックするガードも入っている。
- つまり PR #398/#401/#403 で「アンカーが手順2本文を保持している」前提のロジックは既にある。

## 根本原因の見立て（実装ロールで実データ確定すること）
それでも「締切エージェント起動後の状態に戻る」と報告される → **前提が実データと食い違っている**可能性が高い。
実装ロールは推測せず、次の2点を実コード/実フローで確定する:
1. **実フローとテストの乖離（最有力）**: 既存の revert テストは合成した anchor / group を手で組み立てている
   疑いがある。合成 anchor だと pass するが、実フローの offset-0 タスク content が手順2本文と異なると本番で
   失敗する。**`build_task_drafts`(手順2) → `run_submission_agent`(手順3) → revert-split** を通しで走らせる
   回帰テストを実エンドポイント経由で追加し、復元 content が「手順2のタスク本文」と一致し、生文字起こし全文
   でも締切調査結果の羅列でもないことを pin する。乖離があればアンカー特定/本文スナップショット保持へ是正。
2. **デプロイ差**: PR #398/#401/#403 はいずれも main マージ済みだが完了報告は毎回「本番デプロイが必要」。
   現行 main で実フロー再現テストが通るなら、コードは正しく残るは再デプロイ問題 → Human Check に明示する。

## Next role
実装ロールへ（Implementation: REQUIRED）。実フロー通しの再現テストで root cause を確定してから最小修正。
