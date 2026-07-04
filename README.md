# ai-dev-control-plane

**AI 開発オーケストレーションの「管制塔（control plane）」**。
人間は Linear / Discord から指示を出すだけで、Claude Code が要件整理・設計・タスク分解・実装委譲・検証・PR 作成・マージまでを自律的に回す。

---

## 目次

- [プロジェクト思想](#プロジェクト思想)
- [構想（目指す姿）](#構想目指す姿)
- [アーキテクチャ全体像](#アーキテクチャ全体像)
- [役割分担](#役割分担)
- [ワーカー制御フラグ](#ワーカー制御フラグ)
- [本番障害の自動対応（インシデント・オートレスポンス）](#本番障害の自動対応インシデントオートレスポンス)
- [クイックスタート（実行手順）](#クイックスタート実行手順)
- [ドキュメント](#ドキュメント)

---

## プロジェクト思想

このリポジトリは、**「人間は意思決定だけを行い、実装は AI ワーカー群に委譲する」** という開発スタイルを実現するための制御基盤（control plane）である。

設計の根幹にある原則:

1. **単一の窓口（Single Interface）**
   人間が会話する相手は常に **Claude Code** ただ一つ。Antigravity CLI / Codex CLI といったワーカーへ人間が直接話しかけることはない。人間から見れば「Claude Code がすべてをやってくれる」状態を保つ。

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
        ├─ 実装は Antigravity CLI へ委譲
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
- **lane 並行 / デタッチ実行**: `RUNNER_LANE` で実行レーンを分離し、別 repo の作業を並行ドレインできる（既定は repo 単位の直列。`RUNNER_SERIALIZE_SCOPE=branch` で別 branch も並行可）。`long-run` ラベルの Issue はデタッチ実行され、長時間タスクでもロックを占有しない（`RUNNER_STABLE_MODE=1` のときはデタッチを無効化し同期実行）。詳細は [共通実行キューとログ](docs/runner-queue.md) を参照。

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
        │                   │  webhook-server.ts（即時）│
        │                   └───────────┬────────────┘
        │                               │ runner-cli queue/drain
        │                   ┌───────────▼────────────┐
        └───────────────────│      Claude Code        │  管制塔（唯一の窓口）
                            │  - 要件/設計/タスク分解   │
                            │  - 品質ゲート/最終承認    │
                            └──────┬──────────┬───────┘
                       委譲(実装)  │          │  委譲(検証)
                    ┌──────────────▼──┐   ┌───▼──────────────┐
                    │   Antigravity CLI     │   │    Codex CLI      │
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
| **Antigravity CLI**       | 実装ワーカー                         | `scripts/ai/run_antigravity.sh`                |
| **Codex CLI**        | デバッグ・検証ワーカー               | `scripts/ai/run_codex.sh`                 |
| **スケジューラー**   | Linear をポーリングして起動          | `scripts/ai/scheduler.sh`                 |
| **Webhook サーバー** | Linear/Discord イベントで即時起動    | `src/webhook-server.ts`                   |
| **Discord Bot**      | 遠隔での状態確認・制御               | `src/lib/discord*.ts`                     |
| **自律実行ランナー** | Claude Code を起動する実行エントリ   | `scripts/ai/run_auto.sh`                  |
| **Linear**           | 指示・進捗・状態の管理場所           | 外部 SaaS（MCP / API / Webhook 連携）     |
| **GitHub**           | 成果物・履歴の保管庫                 | 外部 SaaS（`gh` CLI 連携）                |

> **対象アプリの実装場所**: 実装対象のプロジェクトは `/workspaces/<project-name>` にクローンして作業する。この管理プレーン（ai-dev-control-plane）自身は「オーケストレーション基盤」であり、各アプリのコードは含まない。詳細は [`CLAUDE.md`](./CLAUDE.md) の Development Environment を参照。

---

## 役割分担

| 担当            | やること                                                                                 | やらないこと                                                         |
| --------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Claude Code** | 要件整理・設計・タスク分解・ワーカー指示・レビュー・品質ゲート・GitHub 操作・Linear 同期 | 多ファイル実装・lint/test の反復・長時間ログ解析・フル README 再構築 |
| **Antigravity CLI**  | 機能実装・UI/API/ビジネスロジック作成（各機能Issue内の実装担当）                         | スコープ外のリファクタ・設計変更                                     |
| **Codex CLI**   | lint/typecheck/test 実行・原因特定・最小修正・E2E 検証（各機能Issue内の検証担当）        | スコープ拡大・無関係なリファクタ                                     |

### ワーカー非応答時のフォールバック

ワーカー（Antigravity / Codex）が **非応答**（非応答コード `75` / クラッシュ / timeout / レポート欠落）の場合、Claude Code は CLAUDE.md「Worker Non-Response Fallback Policy」に従い、そのワーカーの作業（実装または検証・修正）を直接代行する。Issue をブロックさせないための例外措置であり、代行時も品質ゲート（lint / typecheck / test / 差分レビュー / 受入条件）は同一基準で適用する。詳細は `CLAUDE.md` を参照。

### タスク分解方針

子Issue は **機能単位 / コミット単位** で作成する（工程単位では作成しない）。

- タイトルは成果（アウトカム）で始める。`[IMPLEMENT]` / `[DEBUG]` / `Debug:` / `Test:` などの工程名で始めない。
- 1つの子Issue = 1つの機能変更 = 1つ以上の意味あるcommit。実装・テスト・必要なドキュメント更新を同じIssueに含める。
- Debug / Test は独立Issueにせず、各Issue本文の「検証内容」に含める。
- 子Issue本文: 目的 / 変更範囲 / 実装内容 / 検証内容 / 想定commit / 受け入れ条件 / 関連する親Issue。
- Claude / Antigravity / Codex の役割はIssue分割単位ではなく、各機能Issue内の作業ステップ（方針整理→実装→検証）として扱う。

詳細は `CLAUDE.md` の Child Issue Registration Policy を参照。

---

## ワーカー制御フラグ

ワーカー CLI の起動は環境変数で制御できる。いずれも真値は `1` / `true` / `yes` / `on`（大文字小文字を区別しない）。未設定時は従来どおりワーカーを起動する。実体は `scripts/ai/run_antigravity.sh` / `scripts/ai/run_codex.sh`。

| 変数               | 効果                                                                                                   | 用途                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `WORKER_MODE`      | どのワーカー LLM を起動するかを設定から選ぶ単一スイッチ。値（大小無視, 既定 `all`）: `all`=両方起動 / `claude-only`=両方停止（Claude が全担当, `ALL_CLAUDE_MODE` 相当）/ `codex-only`=Codexのみ（Antigravity を呼ばない）/ `antigravity-only`=Antigravityのみ（Codex を呼ばない）。無効側は対象 CLI を一切起動しない。`ALL_CLAUDE_MODE` の直後・個別フラグ/cooldown より先に評価。 | Codexのみ / Claudeのみ / Antigravityのみモードを切り替えたいとき |
| `ALL_CLAUDE_MODE`  | Antigravity / Codex 両ワーカーを一括無効化し、実装も検証も Claude Code が代行する。`ANTIGRAVITY_DISABLED` の上位互換で、cooldown チェックより先に評価される。 | 全作業を Claude Code だけで回したいとき                    |
| `ANTIGRAVITY_DISABLED`  | Antigravity CLI のみを一時停止する（非応答コード `75` で即終了し、Claude フォールバックへ委譲）。            | Google のプラン変更等で Antigravity CLI が使えない期間          |
| `CODEX_DISABLED`   | Codex CLI のみを一時停止する（`ANTIGRAVITY_DISABLED` と対称。非応答コード `75` で即終了し、Claude フォールバックへ委譲）。 | Codex CLI が使えない期間                                   |

いずれのフラグも、ワーカーを非応答コード `75` で終了させることで、[役割分担](#役割分担)の「ワーカー非応答時のフォールバック」に基づき Claude Code が作業を代行する。

### 実行レーン / 並列制御フラグ

ランナーの並列度・実行レーンは以下の環境変数で制御する（既定は完全直列で後方互換）。詳細は [共通実行キューとログ](docs/runner-queue.md) を参照。

| 変数                    | 効果                                                                                          | 既定   |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------ |
| `RUNNER_MAX_PARALLEL`   | N スロットの並列プールサイズ。`1` で完全直列。                                                  | `1`    |
| `RUNNER_SERIALIZE_SCOPE`| 直列化のスコープ。`repo`=同一 repo 直列 / `branch`=別 branch は別レーンで並行可。               | `repo` |
| `RUNNER_DEFAULT_DETACH` | 通常 run も既定でデタッチ実行する（`1`/`true`）。                                              | `0`    |
| `RUNNER_STABLE_MODE`    | 安定運用の総合スイッチ。並列/デタッチを停止し完全直列に強制（`long-run` のデタッチも無効化）。 | off    |

---

## 本番障害の自動対応（インシデント・オートレスポンス）

上記のワーカー非応答フォールバックが **「Issue を作っている最中（開発／CI）の失敗」** を自己修復するのに対し、本ハーネスは **すでにデプロイ済みのサービスの稼働時障害** に対する自動対応ループも備える（SOT-1520）。対象は監視される側のアプリ（例: toddler-private-rag）で、実体は本リポジトリ（ai-dev-control-plane）にある。

### 自動対応ループ（検知→ポストモーテムまで）

```
① 障害検知        detect     — ヘルスエンドポイントを N 回プローブ → healthy / degraded / unhealthy 判定
② 原因特定        identify   — 失敗プローブのステータス / レイテンシ / エラーを記録
③ 処置            remediate  — 設定されたロールバック / 縮退コマンドを実行（下記の判定を通過した時のみ）
④ 回復確認        verify     — 再プローブして healthy 復帰を確認
⑤ ポストモーテム  postmortem — docs/ai/incidents/<target>-<ts>.md を自動生成
```

### 自動ロールバックは「更新起因のエラー」に限定

障害を検知しても無条件でロールバックはしない。**ロールバックで直る＝更新（デプロイ）起因のエラーの時だけ** 発火する（`classifyFailure` / `decideRollback`。純粋関数・単体テスト済）。

| エラー種別 | 分類 | ロールバック |
| ---------- | ---- | ------------ |
| 5xx | `server-error` | ✅ する（更新起因になり得る） |
| 無応答（接続拒否 / タイムアウト） | `unreachable` | ✅ する（起動失敗＝壊れたデプロイ） |
| 404 | `not-found` | ✅ する（ルート消失） |
| 401 / 403 / 429 / 400 等の 4xx | `client-error` | ⛔ しない（認証・レート・不正リクエスト。前リビジョンに戻しても直らない） |
| その他（想定外 2xx / 3xx） | `unknown` | ⛔ しない |

任意で **デプロイ相関ゲート**（`deployCorrelationWindowMs`）を設定すると、現行リビジョンのデプロイ直後の窓内で起きた障害のみ「更新起因」とみなす（長時間 healthy に稼働後の障害は通知のみ）。判定不能時はフェイルセーフでロールバックしない。判定結果と理由はポストモーテムの「③ 処置」に `✅ rollback / ⛔ no rollback` として記録される。

### サービス側（GCP-native）監視 — ローカルホスト不要

ローカル cron 版（`incident_response.sh`）は常駐ホストが要るが、Cloud Run 向けには **Google のインフラにプローブさせる** 構成が堅牢。`incident_response_gcp_setup.sh` が Cloud Monitoring の **uptime チェック**（`/health` を数分ごとに Google のプローバから叩く。既定 dry-run、`--execute` で作成）を作成し、`gcp_rollback_cloudrun.sh` が現行の1つ前の READY リビジョンを解決して 100% トラフィックを戻す（Cloud Run に `PREVIOUS` キーワードは無いため実リビジョンを解決。既定 dry-run）。アラートポリシー → 通知チャネル → Cloud Function / Cloud Scheduler で完全サーバーレスの検知→ロールバックも構成できる。

### 安全設計（既定 OFF・二段スイッチ）

実監視・実ロールバックはデプロイ環境の認証情報と稼働 URL を要するため、`redeploy_after_merge.sh` と同じく **既定 OFF**。二段スイッチで段階的に有効化する。

| 変数 | 効果 | 既定 |
| ---- | ---- | ---- |
| `INCIDENT_RESPONSE_ENABLED` | ループ全体を有効化（未設定なら丸ごとスキップ） | OFF |
| `INCIDENT_AUTO_REMEDIATE` | 障害確定時にロールバックを **実行**（未設定時は `would run: …` の dry-run ログのみ） | OFF |

監視の有効化だけでは本番トラフィックを触らない。設定・実行手順の詳細は [本番障害の自動対応](docs/incident-response.md) を参照。

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
| Antigravity CLI              | `agy` を起動して認証                                                   |
| Linear（Antigravity 用 MCP） | `~/.gemini/config/mcp_config.json` に linear MCP を用意し `npx -y mcp-remote https://mcp.linear.app/mcp` で認証（再認証は `rm -rf ~/.mcp-auth`） |
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

## 株式・論文データ取得と MCP 設定

Claude Code が株式・論文情報を取得して投資前兆ダッシュボード用データを生成するための、MCP 設定と必要な API キーをまとめる。

### MCP サーバー設定（`.mcp.json`）

Claude Code 用の MCP サーバーは、リポジトリルートの `.mcp.json` で定義する。現在は Linear のみを登録している:

```json
{
  "mcpServers": {
    "linear-server": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp"
    }
  }
}
```

- 認証は `claude` を起動 → `/mcp` → linear を選択（Codex 用は `codex mcp login linear`）。詳細は[クイックスタート](#クイックスタート実行手順) 手順 3 を参照。

### 論文データ取得（arXiv / Semantic Scholar）

論文収集パイプラインは **stock-signal-research プロジェクト**（`/workspaces/stock-signal-research`）に実装されている。この管制プレーン自体は収集コードを持たない。

| ソース | エンドポイント | API キー | 備考 |
| ------ | -------------- | -------- | ---- |
| arXiv | `http://export.arxiv.org/api/query` | **不要** | 3 秒のレート制限あり |
| Semantic Scholar | `https://api.semanticscholar.org/graph/v1` | `SEMANTIC_SCHOLAR_API_KEY`（**任意**） | 未設定なら自動スキップ |

収集の実行方法・統一シグナルレポート JSON の生成方法は、stock-signal-research の README「投資前兆ダッシュボード用 統一シグナルレポート JSON」セクションを参照。

### 株価・財務データ取得 MCP（J-Quants / Alpha Vantage / Finnhub）— 導入予定

株価・財務データを取得する MCP ツール（[SOT-842](https://linear.app/sota-dev/issue/SOT-842)）は **API キー未提供のため未導入**。導入時に必要となる環境変数は次のとおり（取得後に `.env` で管理し、リポジトリにコミットしないこと）:

| 変数名 | 用途 | 対象市場 | 取得先 |
| ------ | ---- | -------- | ------ |
| `JQUANTS_REFRESH_TOKEN` | J-Quants（過去株価・財務） | 日本株（第一候補） | https://jpx-jquants.com/ |
| `ALPHA_VANTAGE_API_KEY` | Alpha Vantage | 米国株・海外株 | https://www.alphavantage.co/support/#api-key |
| `FINNHUB_API_KEY` | Finnhub | 米国株・海外株 | https://finnhub.io/ |

> **Note**: 上記の変数名は SOT-842 導入時の想定であり、実装確定後にこのセクションを更新する。API キーは `.env`（Git 管理外）または Secret Manager で管理し、`.env.example` に実値を書かないこと。

### 必要 API キーまとめ

| 変数名 | 必須 | 用途 |
| ------ | ---- | ---- |
| `ANTHROPIC_API_KEY` | 必須 | Claude Code（オーケストレーター）の動作 |
| `LINEAR_API_KEY` | 任意 | Linear ポーリングモード（MCP 認証とは別） |
| `SEMANTIC_SCHOLAR_API_KEY` | 任意 | 論文収集（stock-signal-research 側で設定） |
| `JQUANTS_REFRESH_TOKEN` / `ALPHA_VANTAGE_API_KEY` / `FINNHUB_API_KEY` | 導入予定 | 株価・財務データ取得 MCP（SOT-842） |

---

## ドキュメント

運用詳細は以下の個別ドキュメントを参照:

- [スケジューラー](docs/scheduler.md) — ポーリング起動・動作モード・操作コマンド
- [Webhook サーバー / Webhook モード](docs/webhook.md) — イベント駆動起動・bootstrap scan・疎通確認・常駐運用
- [共通実行キューとログ](docs/runner-queue.md) — runner.queue.json・処理順序・ロック・retryAt・ログ
- [本番障害の自動対応](docs/incident-response.md) — 稼働監視→エラー分類→ロールバック判定→回復確認→ポストモーテム自動生成
- [usage-limit と Resume](docs/usage-limit-and-resume.md) — cooldown 検知・自動再実行・Resume / Session-Continue
- [Discord Bot](docs/discord-bot.md) — セットアップ・コマンド一覧・ngrok URL 更新
- [環境変数リファレンス](docs/environment-variables.md) — 環境変数・秘密情報の管理
- [tmux / tmuxinator](docs/tmux.md) — 一括起動・セッション操作（詳細は [tmuxinator-setup.md](docs/tmuxinator-setup.md)）
- [セキュリティ・権限方針](docs/security.md) — devcontainer 権限最小化
- [共通 Firebase 認証管理](docs/firebase-auth.md) — Firebase Auth ユーザー管理・Cloud Run 同期
- [Linear Issue アーカイブ運用](docs/linear-issue-archive.md) — Issue 上限到達時のアーカイブ自動化
- [運用規約 (CLAUDE.md)](CLAUDE.md) — Claude Code の動作仕様
