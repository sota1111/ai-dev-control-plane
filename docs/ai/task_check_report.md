# Worker Report — task-check (SOT-1596)

## Summary
対象 Linear Issue: **SOT-1596「分割を戻した後」**（project=toddler-private-rag / repo `/workspaces/toddler-private-rag`）。
task-check（actionability + 分類 + 分解判断）を実施。**actionable、FIX、分解不要、実装が必要**。
要件: タスク分割を戻すボタンを押したら、やることリスト一覧ページ（`/tasks`）へ遷移する。

## (a) Status / Labels / 最新コメント
- Status: **In Progress**（`run_auto.sh` が起動時に In Progress 化済み。task-check では state 変更なし＝冪等 no-op）。
- Labels: なし。Priority: No priority。Assignee: sota morohashi。
- Description: 「タスク分割を戻すボタンを押したら、やることリスト一覧ページに遷移してください。」
- 既存コメント: なし（新規Issue）。task-check にて分解判断＋作業開始コメントを投稿済み。

## (b) 受け入れ条件
`docs/ai/40_acceptance.md` に記載。要点:
- AC1: 登録済みタスク詳細（`DataDetailPage.tsx`）の「分割前のタスクに戻す」成功後、`/tasks` へ遷移（現状 `/data/:id`・`/registered`）。
- AC2: 下書き（`DraftsPage.tsx`）の分割戻し成功後、`/tasks` へ遷移（現状は同ページ滞在）。
- AC3: 遷移は revert-split API 成功後のみ（失敗時は遷移しない）。
- AC4: revert-split 以外の挙動・UI は不変。
- AC5: lint / typecheck / test 通過。

## (c) Actionable?
**Yes（actionable）**。要件は一意で、安全既定（両ボタンとも `/tasks` へ遷移）で進行可能。In Progress。

## (d) タスク種別 + スコープ
- 種別: **FIX**（小さなナビゲーション挙動変更）。
- スコープ: frontend のみ。`frontend/src/pages/DataDetailPage.tsx`（`revertSplitMutation.onSuccess` の遷移先変更）と `frontend/src/pages/DraftsPage.tsx`（revert 成功後に `navigate('/tasks')` 追加、`useNavigate` 取得）。
- 遷移先: `/tasks`（TasksPage「やることリスト」, React Router v6 `useNavigate`）。
- スコープ外: revert-split の API/ロジック、他の遷移・文言・レイアウト。

## (e) 分解判断
**不要**。理由: 単一のナビゲーション挙動変更で少数ファイル・単一PRに収まる。独立機能・別デプロイ単位・複数PRのいずれにも該当しない。Linear に `分解判断: 不要` を投稿済み。子Issueなし。

## Changed Files（本ロール）
- `docs/ai/10_plan.md` — 要件解釈・実装方針。
- `docs/ai/30_tasks.md` — タスクリスト（分解不要、親=作業単位）。
- `docs/ai/40_acceptance.md` — 受け入れ条件。

## Commands Run
- Linear MCP: get_issue / list_comments / save_comment（分解判断＋作業開始）。
- Discord: 開始・完了通知。

## Acceptance Criteria
- [ ] 実装ロール以降で充足予定（本ロールは actionability 判定と計画のみ）。

## Risks
- 「タスク分割を戻すボタン」は2箇所（登録済み詳細・下書き）に存在。安全既定として両方 `/tasks` へ遷移させる方針。人間が片方のみを意図していた場合は Human Check で調整。

## Implementation: REQUIRED

## Next Action: READY_FOR_REVIEW
