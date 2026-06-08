# ai-dev-control-plane

Dev Containers: Rebuild Container

## AI Development Workflow

このリポジトリでは、Linearを状態管理場所、Claude Codeを制御プレーンとして使用する。

Claude CodeはLinear Issueを読み取り、必要に応じて子Issueへ分解し、実装・検証・PR作成までを管理する。

Gemini CLIは実装補助、Codexは検証補助として使用する。

# スケジューラー

`scripts/ai/scheduler.sh` は `CHECK_INTERVAL` 秒ごとに Linear をポーリングし、対象状態の Issue が1件でも存在すれば自動で Claude を起動する。

## 事前準備：`.env` の設定

```bash
cp .env .env.local  # 任意。.env を直接編集してもよい
```

`.env` を開き、最低限以下を記入する：

| 変数                | 説明                      | 取得先                                      |
| ------------------- | ------------------------- | ------------------------------------------- |
| `LINEAR_API_KEY`    | Linear Personal API Token | Linear > Settings > API > Personal API keys |
| `ANTHROPIC_API_KEY` | Anthropic API キー        | console.anthropic.com/settings/keys         |

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

| 変数             | デフォルト | 説明                                                              |
| ---------------- | ---------- | ----------------------------------------------------------------- |
| `LINEAR_API_KEY` | なし       | Linear Personal API Token。設定するとポーリングモードが有効になる |
| `CHECK_INTERVAL` | `60`       | Linear ポーリング間隔（秒）                                       |
| `INTERVAL`       | `3600`     | フォールバック実行間隔（秒）                                      |

## ログ

実行ログは `docs/ai/auto_logs/` に保存される。

```
docs/ai/auto_logs/scheduler.log   # スケジューラー動作ログ
docs/ai/auto_logs/run_*.log       # 各 Claude 実行ログ（タイムスタンプ付き）
```

## セキュリティ・権限方針

このdevcontainerはAI自動実行環境（Claude Code `--dangerously-skip-permissions` モード）であるため、コンテナ側の権限を最小化する。

### 方針

- **不要なLinux capabilityは付与しない** — `NET_ADMIN`・`NET_RAW` などは通常不要であり、`runArgs` に追加しない
- **`privileged: true` は使用しない** — 特権コンテナは設定しない
- **Docker socketは必要になるまでマウントしない** — `/var/run/docker.sock` のバインドマウントは原則行わない
- **非rootユーザーを維持する** — `remoteUser: "vscode"` を維持し、root実行を避ける

### 理由

Claude Codeが `--dangerously-skip-permissions` で動作する場合、コンテナ内での権限昇格リスクを下げるため、devcontainer側で不要な権限を予め排除する。
