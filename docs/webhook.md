# Webhook サーバー / Webhook モード

`npm run start:webhook` で webhook サーバーを起動する。

Linear Webhook の Issue create / update イベントを受信し、対象 Issue を共通実行キューに enqueue して処理する。

ただし以下の Issue の webhook は無視し、キューへの enqueue を行いません。また、実行直前（queue / retry から取り出した際）にも Linear API で最新状態を再検証し、同様の条件に合致する Issue は実行をスキップします：

- state.type が `completed` / `canceled` / `duplicate` の Issue
- `archivedAt` を持つ Archived Issue
- `updatedFrom` に意味のある変更（title / description / priority / assigneeId / stateId 等）がない update（ラベル変更のみなど AI 自身の後処理による更新）

```bash
npm run start:webhook
```

## 起動時 bootstrap scan

webhook サーバーは起動時に Linear の未処理 Issue を確認し、共通 runner queue に自動投入します。起動時 scan はデフォルトで有効です。

| 設定 | 説明 |
|------|------|
| 未設定または `WEBHOOK_BOOTSTRAP_SCAN_ENABLED=true`（デフォルト） | 起動時に Linear の Todo/In Progress Issue を scan して enqueue する |
| `WEBHOOK_BOOTSTRAP_SCAN_ENABLED=false` | 必要な場合のみ起動時 scan を無効化する |

**動作詳細**:

- `LINEAR_API_KEY` が未設定の場合は scan をスキップします
- 取得対象: state が `unstarted`（Todo）または `started`（In Progress）で、archived でない Issue（最大 50 件）。`backlog`（Backlog）は対象外です
- 取得した Issue を trigger=`webhook-bootstrap` で共通 queue に enqueue します
- 既に queue にある Issue は重複登録しません
- usage-limit cooldown 中の場合は `retryAt` を設定して enqueue します（即時実行しません）
- enqueue 完了後に `drainQueue()` を呼び出し、lock が空いていれば処理を開始します
- scan 結果は `docs/ai/auto_logs/auto_runner.log` に `[BOOTSTRAP]` タグで記録されます

**ログ例**:
```
[2026-06-16 09:00:00] [BOOTSTRAP] startup scan started at 2026-06-16T00:00:00.000Z
[2026-06-16 09:00:00] [BOOTSTRAP] startup scan: found 3 active issue(s)
[2026-06-16 09:00:00] [BOOTSTRAP] startup scan: enqueued SOT-619
[2026-06-16 09:00:00] [BOOTSTRAP] startup scan: skip SOT-618 (already queued)
[2026-06-16 09:00:00] [BOOTSTRAP] startup scan complete: enqueued=2 skipped=1
[2026-06-16 09:00:00] [BOOTSTRAP] startup scan: drainQueue complete
```

## Webhook モード（推奨）

ポーリング方式の代わりに、Linear Webhook からイベントを受信してリアルタイムに処理を開始できます。

### 前提条件

- ngrok がインストールされ、`NGROK_COMMAND` が `.env` に設定されていること
- Linear の Webhook 設定が完了していること
  - URL: `https://elitism-unnerving-gallstone.ngrok-free.dev/webhooks/linear`
  - Secret: Linear > Settings > API > Webhooks で確認し、`LINEAR_WEBHOOK_SECRET` に設定

### Webhook モード用 `.env` 設定

`.env` に以下を追加・設定する：

```
WEBHOOK_MODE=true
PORT=3000
LINEAR_WEBHOOK_SECRET=<Linear Webhook の Secret>
NGROK_COMMAND=ngrok http --url=elitism-unnerving-gallstone.ngrok-free.dev 3000
```

### 起動

#### Webhook サーバーと ngrok をまとめて起動（開発用）

```bash
npm run dev:webhook
```

#### 個別起動

```bash
# Webhook サーバーのみ起動
npm run start:webhook

# ngrok のみ起動
npm run start:ngrok
```

#### ポーリングスケジューラーを無効化して起動

```bash
WEBHOOK_MODE=true bash scripts/ai/scheduler.sh
# → "WEBHOOK_MODE=true: ポーリングスケジューラーは無効化されています。" と表示して終了
```

### 疎通確認

#### ローカル疎通確認

```bash
curl -X POST http://localhost:3000/webhooks/linear \
  -H "Content-Type: application/json" \
  -d '{"test":true}'
```

#### ngrok 経由の疎通確認

```bash
curl -X POST https://elitism-unnerving-gallstone.ngrok-free.dev/webhooks/linear \
  -H "Content-Type: application/json" \
  -d '{"test":true}'
```

#### 期待結果

- ローカル・ngrok 経由ともに `{"status":"ignored","reason":"not an issue event"}` が返る（200）
- Webhook サーバーのログに受信ログが出力される
- ngrok の inspection UI（http://127.0.0.1:4040）でリクエストが確認できる

### よくある失敗例

| エラー / 症状                              | 原因                                              | 対処                                                                                                        |
| ------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ERR_NGROK_8012`                           | localhost:3000 の Webhook サーバーが未起動        | `npm run start:webhook` を先に起動してから ngrok を起動するか、`npm run dev:webhook` で両方まとめて起動する |
| ngrok は起動しているが POST が転送されない | Webhook サーバーが起動していない                  | `curl http://localhost:3000/webhooks/linear` でローカル疎通を先に確認する                                   |
| Linear Webhook が届かない                  | Linear 側の Webhook URL がルート URL になっている | Linear > Settings > API > Webhooks で URL が `/webhooks/linear` パス付きで登録されているか確認する          |
| 秘密情報がログに出力される                 | `.env` の値をログ出力している                     | `LINEAR_WEBHOOK_SECRET`・API キー等は絶対にログに出力しない                                                 |
| `.env` がリポジトリに含まれてしまう        | `.gitignore` に `.env` が追加されていない         | `.gitignore` に `.env` が含まれていることを確認し、誤ってコミットした場合はすぐに値を無効化・再発行する     |

### 環境変数（Webhook モード）

| 変数                    | 必須           | デフォルト | 説明                                                                          |
| ----------------------- | -------------- | ---------- | ----------------------------------------------------------------------------- |
| `WEBHOOK_MODE`          | 任意           | `false`    | `true` にするとポーリングを無効化                                             |
| `PORT`                  | 任意           | `3000`     | Webhook サーバーのポート番号                                                  |
| `LINEAR_WEBHOOK_SECRET` | 任意           | なし       | Linear Webhook 署名検証用シークレット。未設定時は開発モードで動作（警告表示） |
| `NGROK_COMMAND`         | Webhook 使用時 | なし       | ngrok 起動コマンド（例: `ngrok http --url=... 3000`）                         |
| `NGROK_WEBHOOK_URL`     | 任意           | なし       | ngrok の公開 URL（確認用）                                                    |

### Webhook サーバー常駐動作・停止・ログ確認

#### 常駐動作の仕組み

`npm run start:webhook` で起動した Webhook サーバーは、対象 Issue を共通実行キューに enqueue し、共通実行パイプラインで処理します。実行プロセスは独立したプロセスグループ（`detached: true`）で動作するため、以下の状況でも Webhook サーバー本体は終了しません：

- `run_auto.sh` / `run_codex.sh` が失敗または Terminated（exit code 143 / SIGTERM）
- Claude / Antigravity / Codex のいずれかが強制終了
- 子プロセスが SIGTERM を受け取った場合

#### サーバーの停止方法

Webhook サーバー本体を停止するには、以下のいずれかを実行します：

```bash
# フォアグラウンドで起動中の場合
Ctrl+C   # SIGINT — サーバーが "Server received SIGINT" をログ出力して正常終了

# バックグラウンドプロセスの場合
kill <PID>   # SIGTERM — サーバーが "Server received SIGTERM" をログ出力して正常終了
```

> **注意**: `kill -9 <PID>`（SIGKILL）を使うとログなしで強制終了します。通常は `kill <PID>` を使用してください。

#### ログの見方

| ログプレフィックス | 意味                                         |
| ------------------ | -------------------------------------------- |
| `[WEBHOOK:PARENT]` | Webhook サーバー本体（親プロセス）のイベント |
| `[RUN:<issueId>]`  | 子プロセスの標準出力・エラー出力             |
| `[WEBHOOK]`        | Webhook 受信・処理ログ                       |

#### 子プロセス終了と親プロセス終了の切り分け

- `[WEBHOOK:PARENT] Server received SIGTERM` → サーバー本体が SIGTERM を受けた（正常終了中）

#### `npm run dev:webhook` での動作

`concurrently --kill-others-on-fail=false` を使って webhook サーバーと ngrok を同時起動します。ngrok が一時的に終了・再起動しても、webhook サーバーは継続して動作します。
