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
docs/ai/auto_logs/run_*.log       # 各 Claude 実行ログ（タイムスタンプ付き）
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

## セキュリティ・権限方針

このdevcontainerはAI自動実行環境（Claude Code `--dangerously-skip-permissions` モード）であるため、コンテナ側の権限を最小化する。

### 方針

- **不要なLinux capabilityは付与しない** — `NET_ADMIN`・`NET_RAW` などは通常不要であり、`runArgs` に追加しない
- **`privileged: true` は使用しない** — 特権コンテナは設定しない
- **Docker socketは必要になるまでマウントしない** — `/var/run/docker.sock` のバインドマウントは原則行わない
- **非rootユーザーを維持する** — `remoteUser: "vscode"` を維持し、root実行を避ける

### 理由

Claude Codeが `--dangerously-skip-permissions` で動作する場合、コンテナ内での権限昇格リスクを下げるため、devcontainer側で不要な権限を予め排除する。
