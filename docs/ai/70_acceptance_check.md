# Acceptance Check — SOT-1596「分割を戻した後」

Issue: タスク分割を戻すボタンを押したら、やることリスト一覧ページ（`/tasks`）へ遷移する。
Repo: `/workspaces/toddler-private-rag` · Branch: `feat/sot-1596-revert-split-goto-tasks`（commit `0e47972`）· Label: なし（`snapshot` なし）

## 独立レビュー（diff main...HEAD を各条件に照合）
変更は frontend の2ファイルのみ（8 insertions / 5 deletions）:
- `frontend/src/pages/DataDetailPage.tsx` — `revertSplitMutation.onSuccess` を `navigate('/tasks')` に変更（旧: `/data/:mergedId` or `/registered`）。未使用の `merged` 引数・`nextId` を除去。`invalidateQueries` 群は維持。`onError` は従来どおり遷移しない。
- `frontend/src/pages/DraftsPage.tsx` — `useNavigate` を import・取得。`handleRevertSplit` の `revertSplitDrafts` 成功（`refreshAll()` 後）に `navigate('/tasks')` を追加。`catch`（失敗時）は遷移しない。

配線確認: DataDetailPage `navigate`(L131) / `handleRevertSplit`(L222) / ボタン `onClick`(L655)、DraftsPage ボタン `onClick`(L461)、`/tasks` ルート（App.tsx L186, `<ProtectedRoute><TasksPage/></ProtectedRoute>`）を実コードで確認。

## 受け入れ条件（met/not-met + 根拠）
- [x] AC1: 登録済み詳細の分割戻し成功後 `/tasks` へ遷移 — **real-action e2e で確認**（就労証明書(1/2)/(2/2) をシード→詳細で「分割前のタスクに戻す」→OK→`toHaveURL(/\/tasks/)` かつ「やることリスト」表示。PASS）。
- [x] AC2: 下書きの分割戻し成功後 `/tasks` へ遷移 — **real-action e2e で確認**（下書き分割群をシード→/drafts で revert→OK→`/tasks` へ遷移。PASS）。
- [x] AC3: 遷移は revert-split API 成功後のみ — diff 確認: DataDetailPage は `onSuccess` 内、DraftsPage は `try` の `await` 成功後に `navigate`。`onError`/`catch` では遷移しない。
- [x] AC4: revert-split 以外の挙動・UI は不変 — diff は revert 経路のみ。既存 e2e 28 件 pass（回帰なし）。out-of-scope 変更なし（working tree clean）。
- [x] AC5: lint / typecheck / test 通過 — verification: `npm run lint` pass / `npx tsc -b` pass / `npm run e2e` 28 passed（unit test スクリプトは当リポジトリに無し）。

## Real-action verification（UI リポジトリ = 必須）
- Playwright（既存 mock harness `installApiMocks` / `login` を使用）で本変更の主フローを実行:
  - 既存フルスイート: **28 passed**（verification ロール）。
  - 本変更専用の一時スペック（`tmp-sot1596.spec.ts`, 非コミット・実行後削除）: **2 passed** — 登録済み詳細・下書きの両 revert 導線で `/tasks` 遷移を実挙動で確認。
- Screenshot: `snapshot` ラベル無しのためコミット不要。遷移先 `/tasks`（やることリスト）は既存 e2e（S9/S15/S16/S17 等）で表示健全性が担保済み。after 証跡は上記 e2e の URL アサーション＋「やることリスト」可視アサーションで代替。
- 一時スペック削除後、`git status` clean（e2e が再生成した `public/howto/*.png` は本変更と無関係のため restore 済み）。

## 判定
すべての受け入れ条件を満たし、real-action 検証（登録済み詳細・下書き両導線で revert→/tasks）が pass、out-of-scope 変更なし。

## Acceptance: PASS
## Next Action: READY_FOR_REVIEW
