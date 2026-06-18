# ai-dev-control-plane

**AI 開発オーケストレーションの「管制塔（control plane）」**。
人間は Linear / Discord から指示を出すだけで、Claude Code が要件整理・設計・タスク分解・実装委譲・検証・PR 作成・マージまでを自律的に回す。

---

## 目次

- [プロジェクト思想](#プロジェクト思想)
- [構想（目指す姿）](#構想目指す姿)
- [アーキテクチャ全体像](#アーキテクチャ全体像)
- [役割分担](#役割分担)
- [クイックスタート（実行手順）](#クイックスタート実行手順)
- [ドキュメント](#ドキュメント)

---

## プロジェクト思想

このリポジトリは、**「人間は意思決定だけを行い、実装は AI ワーカー群に委譲する」** という開発スタイルを実現するための制御基盤（control plane）である。

設計の根幹にある原則:

1. **単一の窓口（Single Interface）**
   人間が会話する相手は常に **Claude Code** ただ一つ。Gemini CLI / Codex CLI といったワーカーへ人間が直接話しかけることはない。人間から見れば「Claude Code がすべてをやってくれる」状態を保つ。

2. **オーケストレーターは実装しない（Separation of Concerns）**
   Claude Code は **判断・委譲・最終承認** に専念する。多ファイル実装・lint/test の反復・長時間ログ解析などの重い作業は、それぞれ専用ワーカーへ渡す。Claude Code 自身は「何を・誰に・どうやらせるか」を決める。

3. **Linear を外部コマンド／状態インターフェースに（State as the Source of Truth）**
   進捗・指示・優先度変更・レビュー依頼はすべて **Linear の Issue / コメント** を通じて行う。開発マシンの前にいなくても、スマホから Linear を見れば進捗が分かり、コメントを書けば指示になる。

4. **GitHub を成果物と履歴の保管庫に（Artifacts & History）**
   ブランチ・コミット・PR・マージはすべて Claude Code が管理し、GitHub に成果物と変更履歴を残す。

5. **品質ゲートを越えたものだけを統合（Quality Gate）**
   lint / typecheck / test / 受入条件をすべて満たした変更のみが PR 化・マージされる。満たさない場合は修正サイクルを自動で回す。

> 詳細な運用規約は [`CLAUDE.md`](./CLAUDE.md) を参照。Claude Code はこの仕様に従って動作する。

---

## 構想（目指す姿）

```
人間（Linear / Discord から指示）
        │  「これ作って」「ここ直して」
        ▼
   Claude Code（管制塔）── 要件整理・設計・タスク分解・最終承認
        │
        ├─ 実装は Gemini CLI へ委譲
        ├─ 検証は Codex CLI へ委譲
        └─ GitHub で PR 作成・マージ、Linear へ状態を同期
        ▲
        │  進捗・完了は Linear / Discord に自動報告
人間（外出先からでも進捗確認）
```

目指すのは、**人間が常時張り付かなくても開発が前に進む「自走する開発ライン」**。

- **イベント駆動**: Linear で Issue を作る／更新すると Webhook が発火し、Claude Code が自動起動する。
- **ポーリング駆動**: Webhook を使わない場合でも、スケジューラーが一定間隔で Linear を監視して未処理 Issue を拾う。
- **遠隔操作**: Discord Bot から `/status` `/queue` `/pause` `/ask` などで状態確認・制御ができる。
- **自己回復**: usage-limit に当たっても、復活時刻を計算して自動でリトライを予約する。

---

## アーキテクチャ全体像

```
┌──────────────┐        ┌──────────────────────────────┐
│   人間        │  指示  │            Linear              │
│ (Linear/      │◄──────►│  Issue / コメント / 状態        │◄─ 状態の同期
│  Discord)     │        └──────────────┬───────────────┘
└──────────────┘                       │ Webhook / ポーリング
        ▲                              ▼
        │ 報告              ┌────────────────────────┐
        │ (Discord)         │   起動レイヤー           │
        │                   │  scheduler.sh（定期監視）│
        │                   │  webhook-server.js（即時）│
        │                   └───────────┬────────────┘
        │                               │ runner-cli queue/drain
        │                   ┌───────────▼────────────┐
        └───────────────────│      Claude Code        │  管制塔（唯一の窓口）
                            │  - 要件/設計/タスク分解   │
                            │  - 品質ゲート/最終承認    │
                            └──────┬──────────┬───────┘
                       委譲(実装)  │          │  委譲(検証)
                    ┌──────────────▼──┐   ┌───▼──────────────┐
                    │   Gemini CLI     │   │    Codex CLI      │
                    │  実装ワーカー     │   │  デバッグ/検証     │
                    └──────────────────┘   └──────────────────┘
                                   │ PR / commit / merge
                            ┌──────▼──────┐
                            │   GitHub     │  成果物・変更履歴
                            └─────────────┘
```

主要コンポーネント:

| コンポーネント       | 役割                                 | 実体                                      |
| -------------------- | ------------------------------------ | ----------------------------------------- |
| **Claude Code**      | オーケストレーター（唯一の人間窓口） | `prompts/claude/auto_run.md` に従って動作 |
| **Gemini CLI**       | 実装ワーカー                         | `scripts/ai/run_gemini.sh`                |
| **Codex CLI**        | デバッグ・検証ワーカー               | `scripts/ai/run_codex.sh`                 |
| **スケジューラー**   | Linear をポーリングして起動          | `scripts/ai/scheduler.sh`                 |
| **Webhook サーバー** | Linear/Discord イベントで即時起動    | `src/webhook-server.js`                   |
| **Discord Bot**      | 遠隔での状態確認・制御               | `src/lib/discord*.js`                     |
| **自律実行ランナー** | Claude Code を起動する実行エントリ   | `scripts/ai/run_auto.sh`                  |
| **Linear**           | 指示・進捗・状態の管理場所           | 外部 SaaS（MCP / API / Webhook 連携）     |
| **GitHub**           | 成果物・履歴の保管庫                 | 外部 SaaS（`gh` CLI 連携）                |

> **対象アプリの実装場所**: 実装対象のプロジェクトは `/workspaces/<project-name>` にクローンして作業する。この管理プレーン（ai-dev-control-plane）自身は「オーケストレーション基盤」であり、各アプリのコードは含まない。詳細は [`CLAUDE.md`](./CLAUDE.md) の Development Environment を参照。

---

## 役割分担

| 担当            | やること                                                                                 | やらないこと                                                         |
| --------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Claude Code** | 要件整理・設計・タスク分解・ワーカー指示・レビュー・品質ゲート・GitHub 操作・Linear 同期 | 多ファイル実装・lint/test の反復・長時間ログ解析・フル README 再構築 |
| **Gemini CLI**  | 機能実装・UI/API/ビジネスロジック作成（各機能Issue内の実装担当）                         | スコープ外のリファクタ・設計変更                                     |
| **Codex CLI**   | lint/typecheck/test 実行・原因特定・最小修正・E2E 検証（各機能Issue内の検証担当）        | スコープ拡大・無関係なリファクタ                                     |

### タスク分解方針

子Issue は **機能単位 / コミット単位** で作成する（工程単位では作成しない）。

- タイトルは成果（アウトカム）で始める。`[IMPLEMENT]` / `[DEBUG]` / `Debug:` / `Test:` などの工程名で始めない。
- 1つの子Issue = 1つの機能変更 = 1つ以上の意味あるcommit。実装・テスト・必要なドキュメント更新を同じIssueに含める。
- Debug / Test は独立Issueにせず、各Issue本文の「検証内容」に含める。
- 子Issue本文: 目的 / 変更範囲 / 実装内容 / 検証内容 / 想定commit / 受け入れ条件 / 関連する親Issue。
- Claude / Gemini / Codex の役割はIssue分割単位ではなく、各機能Issue内の作業ステップ（方針整理→実装→検証）として扱う。

詳細は `CLAUDE.md` の Child Issue Registration Policy を参照。

---

## クイックスタート（実行手順）

### 0. 前提

- Dev Container（Docker）内で動作することを前提とする。VS Code の **Dev Containers: Rebuild Container** でコンテナを起動する。
- Node.js が利用可能であること。

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. `.env` の作成

`.env.example` をコピーして `.env` を作成し、必要な値を記入する:

```bash
cp .env.example .env
```

最低限、以下を記入する:

| 変数                | 必須 | 説明                                                              | 取得先                                      |
| ------------------- | ---- | ----------------------------------------------------------------- | ------------------------------------------- |
| `ANTHROPIC_API_KEY` | 必須 | Anthropic API キー（Claude Code の動作に必要）                    | console.anthropic.com/settings/keys         |
| `LINEAR_API_KEY`    | 任意 | Linear Personal API Token。設定するとポーリングモードが有効になる | Linear > Settings > API > Personal API keys |

> **Note**: `.env` は Git 管理しない。秘密情報（API キー等）は `.env.example` に記入しないこと。環境変数の一覧は [環境変数リファレンス](docs/environment-variables.md) を参照。

### 3. 各種ツールの認証

| 対象                    | コマンド                                                                  |
| ----------------------- | ------------------------------------------------------------------------- |
| Linear（Claude 用 MCP） | `claude` を起動 → `/mcp` → linear を選択                                  |
| Linear（Codex 用 MCP）  | `codex mcp login linear`                                                  |
| Gemini CLI              | `gemini` を起動して認証                                                   |
| Codex CLI               | `codex` を起動して認証                                                    |
| GitHub CLI              | `GH_BROWSER=echo gh auth login --hostname github.com --git-protocol https --web` |
| Azure CLI               | `az login --use-device-code`                                              |
| gcloud                  | `gcloud auth login --no-launch-browser` / `gcloud auth application-default login --no-launch-browser` |

### 4. 起動（いずれか1つ）

**A. ポーリングで自走させる（最も手軽）**

```bash
# ログをリアルタイム表示しながら起動
bash scripts/ai/scheduler.sh --watch

# バックグラウンド起動 / 状態確認 / 停止
bash scripts/ai/scheduler.sh
bash scripts/ai/scheduler.sh status
bash scripts/ai/scheduler.sh stop
```

**B. Webhook でイベント駆動にする（推奨・低レイテンシ）**

```bash
# Webhook サーバーと ngrok をまとめて起動（開発用）
npm run dev:webhook
```

詳細は [Webhook サーバー / Webhook モード](docs/webhook.md) を参照。

**C. 1 回だけ手動実行する**

```bash
# プロンプト内容だけ確認（ドライラン）
bash scripts/ai/run_auto.sh --dry-run

# 実際に1回実行
bash scripts/ai/run_auto.sh
```

### 5. 動作確認

Linear に Issue を作成（または状態を `Todo` / `In Progress` に変更）すると、Claude Code が起動して処理を開始する。進捗は Linear のコメント、または Discord の `/status` で確認できる。

---

## ドキュメント

運用詳細は以下の個別ドキュメントを参照:

- [スケジューラー](docs/scheduler.md) — ポーリング起動・動作モード・操作コマンド
- [Webhook サーバー / Webhook モード](docs/webhook.md) — イベント駆動起動・bootstrap scan・疎通確認・常駐運用
- [共通実行キューとログ](docs/runner-queue.md) — runner.queue.json・処理順序・ロック・retryAt・ログ
- [usage-limit と Resume](docs/usage-limit-and-resume.md) — cooldown 検知・自動再実行・Resume / Session-Continue
- [Discord Bot](docs/discord-bot.md) — セットアップ・コマンド一覧・ngrok URL 更新
- [環境変数リファレンス](docs/environment-variables.md) — 環境変数・秘密情報の管理
- [tmux / tmuxinator](docs/tmux.md) — 一括起動・セッション操作（詳細は [tmuxinator-setup.md](docs/tmuxinator-setup.md)）
- [セキュリティ・権限方針](docs/security.md) — devcontainer 権限最小化
- [共通 Firebase 認証管理](docs/firebase-auth.md) — Firebase Auth ユーザー管理・Cloud Run 同期
- [Linear Issue アーカイブ運用](docs/linear-issue-archive.md) — Issue 上限到達時のアーカイブ自動化
- [運用規約 (CLAUDE.md)](CLAUDE.md) — Claude Code の動作仕様
