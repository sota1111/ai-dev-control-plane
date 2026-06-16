# Gemini CLI / Claude Code: Issue-Rerun Resume Prompt

## 概要 / Overview
このプロンプトは、利用制限（Usage Limit）により中断されたタスクを再開するための専用プロンプトです。
これは新規のタスクではなく、既存のワークフローの継続であることを認識してください。

## 認証の前提 / Authentication Assumptions
READMEに記載の以下の認証は完了済みとみなします。再認証は不要です。
- Linear MCP, Gemini CLI, Codex CLI, GitHub CLI, Azure CLI, gcloud

## 再開時の必須フロー / Mandatory Resume Flow

### 1. 状態の把握 (Context Discovery)
まず最初に、以下の情報を読み取って現在の状況を正確に把握してください。
- 再開メタデータ: `docs/ai/auto_logs/resume/<ISSUE_ID>.json` (存在する場合)
- 前回実行ログ: メタデータ内の `previousRunLog` パス
- Linear Issue の最新状態: ステータス、最新のコメント、チェックリスト
- Git の状態: 現在のブランチ (`git branch --show-current`)、差分 (`git status --short`)

### 2. 再開前処理 (Pre-Resume Check & Linear Sync)
作業を開始する前に、必ず以下の操作を実行してください。

- **重複/終了確認**: Issue が既に `Completed`, `Canceled`, `Archived`, `Duplicate` のいずれかである場合は、何もせずに終了してください。
- **ステータス更新**: ステータスが `Todo` の場合は `In Progress` に更新してください。
- **ラベル削除**: `usage-limit` ラベルが付与されている場合は削除してください。
- **再開コメントの投稿**: Linear に以下の内容でコメントを投稿してください。
  ```
  ## 再開報告 (Issue-Rerun Resume)
  利用制限後の自動再開を開始しました。
  - 再開モード: issue-rerun
  - retryAt: <retryAt>
  - ブランチ: <current-branch>
  - 前回のログ: <previousRunLog>
  ```
  （resumeMode / retryAt / branch / previousRunLog は再開メタデータJSONから読み取ること）

### 3. 作業の継続 (Continuation)
- **重複作業の禁止**: 前回既に完了している調査や実装を繰り返さないでください。
- **不足分の特定**: 何が未完了で、次のアクションが何であるかを判断し、そこから作業を再開してください。
- **一貫性の維持**: 既存の PR やブランチがある場合はそれを使用し、新しいものを無闇に作成しないでください。

## エージェントの責務境界 / Agent Responsibility Boundary
- `auto_run.md` と同様の基準で Gemini (実装) / Codex (検証/不具合修正) への委譲を行ってください。これらはひとつの feature/commit Issue 内のステップとして実行されます。
- すでにタスクチェック (Codex) が完了している場合は、再度実行する必要はありません。

## 権限エラーの処理 / Permission Error Handling
- 権限不足に遭遇した場合は `auto_run.md` の規定に従い、ステータスを `In Review` に変更して報告コメントを残し、終了してください。

## 終了条件 / Termination Conditions
- Issue が `Done` に到達するか、解決不能なブロック状態になった場合に終了してください。
- 無限ループや、対話の待機は厳禁です。
