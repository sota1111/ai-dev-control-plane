# ai-dev-control-plane

Dev Containers: Rebuild Container

## AI Development Workflow

このリポジトリでは、Linearを状態管理場所、Claude Codeを制御プレーンとして使用する。

Claude CodeはLinear Issueを読み取り、必要に応じて子Issueへ分解し、実装・検証・PR作成までを管理する。

Gemini CLIは実装補助、Codexは検証補助として使用する。

# スケジューラー

`scripts/ai/scheduler.sh` は `CHECK_INTERVAL` 秒ごとに Linear をポーリングし、対象状態の Issue が1件でも存在すれば自動で Claude を起動する。

## 事前準備：`.env` の設定

`.env.example` をコピーして `.env` を作成し、必要な値を記入する：

```bash
cp .env.example .env
```

`.env` を開き、最低限以下を記入する：

| 変数                | 必須 | 説明                      | 取得先                                      |
| ------------------- | ---- | ------------------------- | ------------------------------------------- |
| `LINEAR_API_KEY`    | 任意 | Linear Personal API Token。設定するとポーリングモードが有効になる | Linear > Settings > API > Personal API keys |
| `ANTHROPIC_API_KEY` | 必須 | Anthropic API キー        | console.anthropic.com/settings/keys         |

> **Note**: `.env` はGit管理しない。秘密情報（APIキー等）は `.env.example` に記入しないこと。

## 動作モード

### Linear ポーリングモード（推奨）

`LINEAR_API_KEY` が設定されている場合、`CHECK_INTERVAL` 秒ごとに Linear API をポーリングする。
Linear 上の Issue 状態タイプが `unstarted`（Backlog/Todo）または `started`（In Progress）の Issue が1件でも存在する場合、`scripts/ai/run_auto.sh` を実行する。
Issue の更新差分（`updatedAt` の変化）は現在判定していない。

### フォールバックモード

`LINEAR_API_KEY` が未設定の場合、`INTERVAL` 秒ごとに無条件で Claude を実行する。

## コマンド

### 起動前準備

#### linear認証

```
claude
/mcp
linearを選択
```

#### gemini認証

```
gemini
```

#### codex認証

```
codex
```

#### codex MCP認証（Linear）

```
codex mcp login linear
```

#### GitHub CLI 認証

```
gh auth login
```

#### azure 認証

```
az login --use-device-code
```

#### gcloud 認証

```bash
gcloud auth login
gcloud auth application-default login
```

### 起動（ログをリアルタイム表示）

```bash
bash scripts/ai/scheduler.sh --watch
```

### バックグラウンドで起動

```bash
bash scripts/ai/scheduler.sh
```

### 状態確認

```bash
bash scripts/ai/scheduler.sh status
```

出力例：

```
Scheduler is running (PID: 12345)
Log: docs/ai/auto_logs/scheduler.log
Mode: Linear polling (CHECK_INTERVAL=60s)
```

### 停止

```bash
bash scripts/ai/scheduler.sh stop
```

## Webhook サーバー

`npm run start:webhook` で webhook サーバーを起動する。

Linear Webhook の Issue create / update イベントを受信し、`scripts/ai/run_auto.sh` を起動する。

ただし以下の Issue の webhook は無視し、`run_auto.sh` を起動しません。また、実行直前（queue / retry から取り出した際）にも Linear API で最新状態を再検証し、同様の条件に合致する Issue は実行をスキップします：

- state.type が `completed` / `canceled` / `duplicate` の Issue
- `archivedAt` を持つ Archived Issue
- `updatedFrom` に意味のある変更（title / description / priority / assigneeId / stateId 等）がない update（ラベル変更のみなど AI 自身の後処理による更新）

```bash
npm run start:webhook
```

## 共通ログ

scheduler と webhook の両方が `docs/ai/auto_logs/auto_runner.log` へログを書き込む。

```
docs/ai/auto_logs/
  auto_runner.log   # 共通ログ（scheduler + webhook + run_auto.sh 出力）
  scheduler.log     # scheduler.sh の後方互換ログ（auto_runner.log と同内容）
  runner.lock       # プロセス間共通ロックファイル
  runner.queue.json # 保留キューファイル（webhook 側のリトライ管理）
```

ログ行フォーマット例:
```
[2026-06-12 12:00:00] [SCHEDULER] Next check in 60s
[2026-06-12 12:01:00] [SCHEDULER] LOCK acquired (pid=12345)
[2026-06-12 12:01:00] [SCHEDULER] --- Run start (active issues found) ---
[2026-06-12 12:06:00] [SCHEDULER] --- Run completed successfully ---
[2026-06-12 12:06:00] [SCHEDULER] LOCK released (pid=12345)
```

## 重複起動防止（scheduler と webhook の共存）

scheduler と webhook は **同一のロックファイル** `docs/ai/auto_logs/runner.lock` を使用する。

- `run_auto.sh` の起動前にロックを取得し、完了後に解放する
- ロック取得失敗時は `SKIPPED_LOCKED` としてログに出力し、`run_auto.sh` を起動しない
- SKIPPED_LOCKED は成功扱いしない
- ロックファイルのプロセスが死んでいる場合、または 30分以上経過した場合は stale lock として自動削除・再取得する

## usage-limit 検知時の挙動

`run_auto.sh` が usage-limit で失敗した場合:
1. Linear の対象 Issue にコメントを投稿（次回実行予定時刻 JST 付き）
2. 対象 Issue に `usage-limit` ラベルを付与（既存ラベルは保持）
3. リセット時刻 +10分後を Claude Code 全体の cooldown として保存
4. cooldown 中に届いた webhook は `run_auto.sh` を起動せず、同じ retry 時刻でキューに追加
5. retry 実行後、成功した場合は cooldown と `usage-limit` ラベルを除去

## retry 予約と実行の仕様

- webhook 経由の retry は `docs/ai/auto_logs/runner.queue.json` で管理される
- キューは webhook サーバー再起動後も永続化される
- 同一 Issue の retry が複数回登録されても1件にまとめられる
- scheduler 側は現状インメモリで retry を管理（将来的に統合予定）

## ロック取得失敗時の扱い

- scheduler: `SKIPPED_LOCKED` としてログに出力し、次の CHECK_INTERVAL 待機後に再試行する
- webhook: `SKIPPED_LOCKED` としてログに出力し、キューに入れて後続で再実行する
- どちらも `run_auto.sh` が処理を完了していない場合に "completed successfully" を出力しない

## pending queue の扱い（webhook）

- `enqueue(issueId, trigger, retryAt)` でキューに追加（重複排除）
- `retryAt` が null の場合は即座に実行可能
- `retryAt` が将来時刻の場合はその時刻以降に実行
- ロック取得失敗時にキューに戻し、後続処理で実行

## Discord Bot セットアップ

### 1. Discord Application 作成

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス
2. 「New Application」をクリックし、アプリ名を入力
3. 左メニューの「Bot」→「Add Bot」をクリック
4. 「Reset Token」でBot Tokenを取得（一度しか表示されないので保存）
5. 左メニューの「General Information」から Application ID と Public Key を取得

### 2. 環境変数を設定

`.env` ファイルに以下を追加:

```env
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_APPLICATION_ID=your_application_id_here
DISCORD_PUBLIC_KEY=your_public_key_here
```

### 3. Interactions Endpoint URL を設定

1. ngrok などでサーバーを公開: `npm run dev:webhook`
2. Discord Developer Portal の「General Information」→「Interactions Endpoint URL」に `https://your-domain.ngrok.io/webhooks/discord` を設定
3. Discordが検証リクエストを送信し、成功すれば設定完了

### 4. スラッシュコマンドを登録

```bash
node scripts/register_discord_commands.js
```

### 5. Bot をサーバーに招待

1. Discord Developer Portal の「OAuth2」→「URL Generator」
2. Scopes: `bot`, `applications.commands` を選択
3. Bot Permissions: `Send Messages` を選択
4. 生成されたURLでサーバーに招待

### 利用可能なコマンド

| コマンド | 説明 |
|---------|------|
| `/status` | 実行中Issue、ロック状態、キュー数、cooldownを表示 |
| `/queue` | 実行キューの内容を表示 |
| `/cooldown` | usage-limit cooldown状態を表示 |
| `/pause` | 新規実行を一時停止 |
| `/resume` | 一時停止を解除 |
| `/reply issue:SOT-xxx body:...` | 指定IssueへLinearコメントを投稿 |
| `/retry issue:SOT-xxx` | 指定Issueを再実行キューへ投入 |
| `/ask` | 自然言語で質問・指示（モーダルが開く） |

## 環境変数リファレンス

| 変数                | 必須     | デフォルト | 説明                                                              |
| ------------------- | -------- | ---------- | ----------------------------------------------------------------- |
| `LINEAR_API_KEY`    | 任意     | なし       | Linear Personal API Token。設定するとポーリングモードが有効になる |
| `ANTHROPIC_API_KEY` | 必須     | なし       | Anthropic API キー。Claude Code の動作に必要                      |
| `CHECK_INTERVAL`    | 任意     | `60`       | Linear ポーリング間隔（秒）                                       |
| `INTERVAL`          | 任意     | `3600`     | フォールバック実行間隔（秒）                                      |
| `TZ`                | 任意     | システム依存 | ログや実行環境のタイムゾーン（例: `Asia/Tokyo`）                 |

### 秘密情報の管理

- `.env` はGit管理しない（`.gitignore` で除外済み）
- `.env.example` には実際のAPIキーやトークンを記入しない
- APIキー、トークン、認証情報はログやREADMEに出力しない
- 誤って秘密情報をコミットした場合は、すぐに値を無効化・再発行すること

## ログ

実行ログは `docs/ai/auto_logs/` に保存される。

```
docs/ai/auto_logs/scheduler.log   # スケジューラー動作ログ
docs/ai/auto_logs/run_*.log       # 各 Claude 実行ログ（run_auto.sh が生成、タイムスタンプ付き）
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

| エラー / 症状 | 原因 | 対処 |
|---|---|---|
| `ERR_NGROK_8012` | localhost:3000 の Webhook サーバーが未起動 | `npm run start:webhook` を先に起動してから ngrok を起動するか、`npm run dev:webhook` で両方まとめて起動する |
| ngrok は起動しているが POST が転送されない | Webhook サーバーが起動していない | `curl http://localhost:3000/webhooks/linear` でローカル疎通を先に確認する |
| Linear Webhook が届かない | Linear 側の Webhook URL がルート URL になっている | Linear > Settings > API > Webhooks で URL が `/webhooks/linear` パス付きで登録されているか確認する |
| 秘密情報がログに出力される | `.env` の値をログ出力している | `LINEAR_WEBHOOK_SECRET`・API キー等は絶対にログに出力しない |
| `.env` がリポジトリに含まれてしまう | `.gitignore` に `.env` が追加されていない | `.gitignore` に `.env` が含まれていることを確認し、誤ってコミットした場合はすぐに値を無効化・再発行する |

### 環境変数（Webhook モード）

| 変数 | 必須 | デフォルト | 説明 |
|------|------|-----------|------|
| `WEBHOOK_MODE` | 任意 | `false` | `true` にするとポーリングを無効化 |
| `PORT` | 任意 | `3000` | Webhook サーバーのポート番号 |
| `LINEAR_WEBHOOK_SECRET` | 任意 | なし | Linear Webhook 署名検証用シークレット。未設定時は開発モードで動作（警告表示） |
| `NGROK_COMMAND` | Webhook 使用時 | なし | ngrok 起動コマンド（例: `ngrok http --url=... 3000`） |
| `NGROK_WEBHOOK_URL` | 任意 | なし | ngrok の公開 URL（確認用） |

### Webhook サーバー常駐動作・停止・ログ確認

#### 常駐動作の仕組み

`npm run start:webhook` で起動した Webhook サーバーは、AI 実行（`run_auto.sh`）を子プロセスとして起動します。子プロセスは独立したプロセスグループ（`detached: true`）で動作するため、以下の状況でも Webhook サーバー本体は終了しません：

- `run_auto.sh` / `run_codex.sh` が失敗または Terminated（exit code 143 / SIGTERM）
- Claude / Gemini / Codex のいずれかが強制終了
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

| ログプレフィックス | 意味 |
|---|---|
| `[WEBHOOK:PARENT]` | Webhook サーバー本体（親プロセス）のイベント |
| `[RUN:<issueId>]` | 子プロセスの標準出力・エラー出力 |
| `[WEBHOOK]` | Webhook 受信・処理ログ |

#### 子プロセス終了と親プロセス終了の切り分け

- `[WEBHOOK:PARENT] Server received SIGTERM` → サーバー本体が SIGTERM を受けた（正常終了中）

#### `npm run dev:webhook` での動作

`concurrently --kill-others-on-fail=false` を使って webhook サーバーと ngrok を同時起動します。ngrok が一時的に終了・再起動しても、webhook サーバーは継続して動作します。

## セキュリティ・権限方針

このdevcontainerはAI自動実行環境（Claude Code `--dangerously-skip-permissions` モード）であるため、コンテナ側の権限を最小化する。

### 方針

- **不要なLinux capabilityは付与しない** — `NET_ADMIN`・`NET_RAW` などは通常不要であり、`runArgs` に追加しない
- **`privileged: true` は使用しない** — 特権コンテナは設定しない
- **Docker socketは必要になるまでマウントしない** — `/var/run/docker.sock` のバインドマウントは原則行わない
- **非rootユーザーを維持する** — `remoteUser: "vscode"` を維持し、root実行を避ける

### 理由

Claude Codeが `--dangerously-skip-permissions` で動作する場合、コンテナ内での権限昇格リスクを下げるため、devcontainer側で不要な権限を予め排除する。

## Usage Limit 自動再実行

### 概要

webhook 経由で起動した Claude Code が usage limit に達した場合、usage 復活時刻 + 10分後まで Claude Code 全体を cooldown にします。cooldown 中に届いた webhook は新規実行せず、同じ retry 時刻でキューに追加します。

### 環境変数

| 変数名 | デフォルト | 説明 |
|--------|-----------|------|
| `USAGE_LIMIT_RETRY_BUFFER_SECONDS` | `600` | usage 復活後の追加待機秒数 |

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
