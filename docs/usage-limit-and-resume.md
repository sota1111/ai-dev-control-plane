# usage-limit と Resume

usage-limit 検知時の cooldown / 自動再実行、および中断タスクの再開（Resume / Session-Continue）の仕様をまとめる。

## usage-limit 検知時の挙動

`run_auto.sh` が usage-limit で失敗した場合:

1. **検知と分類**: エラー出力を解析し、以下のタイプに分類します:
   - `session_limit`: セッションあたりの制限（リトライ可能）
   - `api_429`: API レート制限（リトライ可能）
   - `weekly_limit`: 週次制限（リトライ不可）
   - `auth_error`: 認証エラー（リトライ不可）
   - `network_error`: ネットワークエラー（リトライ可能）
   - `model_unavailable`: モデル一時利用不可（リトライ可能）
   - `context_limit`: コンテキスト長制限（リトライ不可・要要約）
   - `unknown`: 分類不能（デフォルトはリトライ不可）
2. **通知**: Linear の対象 Issue にコメントを投稿（次回実行予定時刻 JST 付き）。同一 Issue・同一 retry 時刻のコメントが既に存在する場合は投稿しない（重複防止）。対象 Issue に `usage-limit` ラベルを付与します。
3. **Cooldown**: リセット時刻 +10分後を Claude Code 全体の cooldown として `runner.cooldown.json` に永続化します。ここには `reason` や `limitType` も記録されます。
4. **自動リトライ**: リトライ可能なタイプの場合、cooldown 解除時刻を `retryAt` としてキューに再投入します。この際 `reason=usage_limit` が付与され、再開モードで実行されます。
5. **解除**: 成功した場合は cooldown と `usage-limit` ラベルを除去します。

## Resume (Issue-Rerun)

中途で中断（usage-limit 等）されたタスクを、前回までのコンテキストを保持して再開する仕組みです。

- **実行**: `bash scripts/ai/run_auto.sh --resume` または Discord `/resume issue`
- **専用プロンプト**: `prompts/claude/auto_resume.md` を使用し、無駄な重複作業を避けます
- **メタデータ**: `docs/ai/auto_logs/resume/<issue>.json` に前回の終了理由、リセット時刻、Git 状態、ログの断片を記録します
- **チェックポイント**: ログに `[RESUME]` タグで再開ポイントを記録し、トレーサビリティを確保します
- **統合**: スケジューラー、Webhook、Discord、手動実行すべてがこの共通パスを使用します

## Session-Continue (Opt-in)

既存の tmux pane で実行中の Claude Code セッションに `continue` を送信する補助機能です。

- **実行**: `npm run resume:session -- --pane <pane> [--issue <id>]` または Discord `/resume session`
- **検証**: 送信前に pane が存在し、フォアグラウンドで Claude Code が動作しているか確認します。
- **待機状態**: usage-limit 中であれば `docs/ai/auto_logs/runner.session-continue.json` に `waiting` 状態を記録し、時刻まで待機します。
- **補完**: Issue-Rerun (Resume) を置き換えるものではなく、人間が手動で pane を開いている場合の補助として機能します。

## Usage Limit 自動再実行

### 概要

webhook 経由で起動した Claude Code が usage limit に達した場合、usage 復活時刻 + 10分後まで Claude Code 全体を cooldown にします。`529 Overloaded` 等の過負荷エラーは1時間後に再開します。cooldown 中に届いた webhook は新規実行せず、同じ retry 時刻でキューに追加します。

### 環境変数

| 変数名                             | デフォルト | 説明                                                               |
| ---------------------------------- | ---------- | ------------------------------------------------------------------ |
| `USAGE_LIMIT_RETRY_BUFFER_SECONDS` | `600`      | usage 復活後の追加待機秒数                                         |
| `OVERLOAD_RETRY_BUFFER_SECONDS`    | `3600`     | 529/overloaded 等のサーバ過負荷エラー後の再開待機秒数（既定1時間） |

### 手動確認手順

1. webhook server を起動する

   ```bash
   npm run start:webhook
   ```

2. webhook エンドポイントにテストイベントを送信する（run_auto.sh が usage limit エラーを返す状況を用意する）

   ```bash
   curl -X POST http://localhost:3000/webhooks/linear \
     -H "Content-Type: application/json" \
     -d '{"type":"Issue","action":"update","data":{"identifier":"TEST-001","title":"test","state":{"name":"In Progress"},"labels":[]}}'
   ```

3. ログで再実行が予約されていることを確認する

   ```
   [RUN] issue=TEST-001 trigger=webhook usage limit detected
   [RETRY] issue=TEST-001 trigger=webhook scheduled retryAt=<ISO>
   ```

4. 同じ issueId の webhook を連続送信しても二重実行されないことを確認する

   ```bash
   curl -X POST http://localhost:3000/webhooks/linear \
     -H "Content-Type: application/json" \
     -d '{"type":"Issue","action":"update","data":{"identifier":"TEST-001","title":"test","state":{"name":"In Progress"},"labels":[]}}'
   # → {"status":"ignored","reason":"already queued: TEST-001"}
   ```

5. 再実行時に同じ issueId が処理されることを確認する
   - ログに `[WEBHOOK] Retry starting for issueId=TEST-001` が表示される
