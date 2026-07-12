# Tasks — SOT-1594 「分割を戻す」ボタンのバグ（REOPEN #4）

分解判断: **不要**（単一バグの追加是正。backend の復元ロジック＋テストが1PRに収まり、独立した
rollback/deploy 単位や並行 PR の利得がない）。親Issueをそのまま作業単位とする。

対象リポジトリ: `/workspaces/toddler-private-rag`（backend, FastAPI）

## Task list（implementation ロール向け）

1. **実フロー再現テストを先に書く（root cause 確定, AC7）**
   - `build_task_drafts`(手順2) で写真1枚→複数タスク draft を作り、そのうち提出物タスクに対して
     `run_submission_agent` 相当（`routers/info.py:728` の締切調査フロー）を実行して締切グループ (1/N)…(N/N)
     ＋ offset-0 アンカーを作る。
   - その (n/N) タスクで `/drafts/{id}/revert-split`（および本登録版）を実エンドポイント経由で叩く。
   - 復元 content が **手順2タスク本文** と一致し、生文字起こし全文でも締切調査結果の羅列でもないこと、
     title が写真書類でなくアンカーのタイトルであることを assert（AC2/AC3/AC4）。
   - このテストが **現行 main で pass するか fail するか** を最初に確認する。

2. **fail する場合のみ最小修正（AC1–AC6）**
   - `_find_anchor_dict` / `_resolve_revert_group`（`routers/info.py:437,462`）のアンカー特定が実データで
     正しく offset-0・非付随タスクを引けているか確認。引けていなければ是正。
   - 必要なら締切エージェント起動前（手順2）の本文をスナップショットとして永続化し、そこから復元する方針に
     切り替える（アンカー content が実データで手順2本文を保持していない場合）。
   - `merge_split_drafts_to_single`（`extraction.py:1121`）の anchor 復元・フォールバックガードは維持。
   - PR #398 の締切グループ限定スコープを退行させない（AC5）。

3. **pass する場合（AC9）**
   - コードは正しく、残差は本番未デプロイの可能性が高い旨を報告に明記し Human Check とする。
   - それでも実データ固有の乖離が疑わしければ、実 DB レコード形状に近いフィクスチャで追試する。

4. **検証（AC8）**
   - backend フルスイート（pytest）pass、coverage floor（70%）維持、revert/split 系テスト緑。
   - 変更は backend のみ・意図しない差分なしを確認。

## 備考
- REOPEN #4。過去 PR #398（グループ限定スコープ）/#401（title/content をアンカー復元）/#403（生文字起こし
  フォールバックガード）は全て main マージ済み。今回は「まだ締切エージェント起動後の状態に戻る」という
  再報告に対し、**実フロー通しの再現で前提と実データの食い違いを潰す**のが主眼。
