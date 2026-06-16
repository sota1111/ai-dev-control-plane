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
- [tmux / tmuxinator](#tmux--tmuxinator)
- [スケジューラー](#スケジューラー)
- [Webhook サーバー](#webhook-サーバー)
- [Discord Bot セットアップ](#discord-bot-セットアップ)
- [環境変数リファレンス](#環境変数リファレンス)
- [共通 Firebase 認証管理](#共通firebase認証管理)

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

> **Note**: `.env` は Git 管理しない。秘密情報（API キー等）は `.env.example` に記入しないこと。

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

詳細は [Webhook サーバー](#webhook-サーバー) と [Webhook モード](#webhook-モード推奨) を参照。

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

## tmux / tmuxinator

tmuxinator を使うと、Webhook サーバー・ngrok・Claude / Codex / Gemini CLI・ステータス確認用 pane を**一括起動**できる。

詳細は [`docs/tmuxinator-setup.md`](./docs/tmuxinator-setup.md) を参照。

### インストール

```bash
# tmux（通常はプリインストール済み）
which tmux || sudo apt-get install -y tmux

# tmuxinator
gem install tmuxinator
```

### 設定ファイルのリンク

```bash
# シンボリックリンクを張る
ln -s /workspaces/ai-dev-control-plane/.config/tmuxinator/ai-auth.yml ~/.config/tmuxinator/ai-auth.yml
ln -s /workspaces/ai-dev-control-plane/.config/tmuxinator/ai-dev.yml  ~/.config/tmuxinator/ai-dev.yml
```

### 起動コマンド

| 用途                                 | コマンド                                             |
| ------------------------------------ | ---------------------------------------------------- |
| 初回認証（全 CLI を順番に認証）      | `tmuxinator start ai-auth`                           |
| 通常開発（Webhook + ngrok + 各 CLI） | `tmuxinator start ai-dev`                            |
| パス直接指定で起動（リンク不要）     | `tmuxinator start -p .config/tmuxinator/ai-auth.yml` |

### 初期起動コマンド詳細

#### `tmuxinator start ai-dev`（通常開発）

| ウィンドウ | pane | 実行コマンド                                             |
| ---------- | ---- | -------------------------------------------------------- |
| `webhook`  | 左   | `npm run dev:webhook`（Webhook サーバー起動）            |
| `webhook`  | 右   | `ngrok http 3000`（ngrok トンネル起動）                  |
| `claude`   | —    | `claude`                                                 |
| `codex`    | —    | `codex`                                                  |
| `gemini`   | —    | `gemini`                                                 |
| `status`   | 上   | `git status && git log --oneline -5`                     |
| `status`   | 中   | `ps aux \| grep -E "node\|ngrok\|claude\|codex\|gemini"` |
| `status`   | 下   | `ls -la logs/`                                           |

#### `tmuxinator start ai-auth`（初回認証）

| ウィンドウ  | 実行コマンド                                                  |
| ----------- | ------------------------------------------------------------- |
| `claude`    | `claude`（起動後 `/mcp` → Linear を選択して MCP 設定）        |
| `gemini`    | `gemini`                                                      |
| `codex`     | `codex`                                                       |
| `codex-mcp` | `codex mcp login linear`                                      |
| `gh`        | `GH_BROWSER=echo gh auth login --hostname github.com --git-protocol https --web` |
| `azure`     | `az login --use-device-code`                                  |
| `gcloud`     | `gcloud auth login --no-launch-browser` |
| `gcloud-adc` | `gcloud auth application-default login --no-launch-browser` |

### セッション操作

| 操作                          | コマンド                      |
| ----------------------------- | ----------------------------- |
| セッションから抜ける (detach) | `Ctrl+b d`                    |
| セッションに戻る (attach)     | `tmux attach -t ai-dev`       |
| セッション一覧                | `tmux ls`                     |
| セッション終了                | `tmux kill-session -t ai-dev` |

---

# スケジューラー

`scripts/ai/scheduler.sh` は `CHECK_INTERVAL` 秒ごとに Linear をポーリングし、対象状態の Issue を共通実行キューに enqueue して drain を実行する。

> 事前準備（`.env` の作成と各種認証）は [クイックスタート](#クイックスタート実行手順) を参照。

## 動作モード

### Linear ポーリングモード（推奨）

`LINEAR_API_KEY` が設定されている場合、`CHECK_INTERVAL` 秒ごとに Linear API をポーリングする。
Linear 上の Issue 状態タイプが `unstarted`（Backlog/Todo）または `started`（In Progress）の Issue が存在する場合、各 Issue を `node src/runner-cli.js enqueue` でキューに追加し、`node src/runner-cli.js drain` で共通実行パイプラインを通じて処理する。
Issue の更新差分（`updatedAt` の変化）は現在判定していない。

### フォールバックモード

`LINEAR_API_KEY` が未設定の場合、`INTERVAL` 秒ごとに無条件で Claude を実行する。

## スケジューラー操作コマンド

```bash
bash scripts/ai/scheduler.sh --watch   # ログをリアルタイム表示しながら起動
bash scripts/ai/scheduler.sh           # バックグラウンド起動
bash scripts/ai/scheduler.sh status    # 状態確認
bash scripts/ai/scheduler.sh stop      # 停止
```

`status` の出力例：

```
Scheduler is running (PID: 12345)
Log: docs/ai/auto_logs/scheduler.log
Mode: Linear polling (CHECK_INTERVAL=60s)
```

## Webhook サーバー

`npm run start:webhook` で webhook サーバーを起動する。

Linear Webhook の Issue create / update イベントを受信し、対象 Issue を共通実行キューに enqueue して処理する。

ただし以下の Issue の webhook は無視し、キューへの enqueue を行いません。また、実行直前（queue / retry から取り出した際）にも Linear API で最新状態を再検証し、同様の条件に合致する Issue は実行をスキップします：

- state.type が `completed` / `canceled` / `duplicate` の Issue
- `archivedAt` を持つ Archived Issue
- `updatedFrom` に意味のある変更（title / description / priority / assigneeId / stateId 等）がない update（ラベル変更のみなど AI 自身の後処理による更新）

```bash
npm run start:webhook
```

### 起動時 bootstrap scan

`WEBHOOK_BOOTSTRAP_SCAN_ENABLED=true` を設定すると、webhook サーバー起動時に Linear の未処理 Issue を確認し、共通 runner queue に自動投入します。

| 設定 | 説明 |
|------|------|
| `WEBHOOK_BOOTSTRAP_SCAN_ENABLED=true` | 起動時に Linear の Todo/In Progress Issue を scan して enqueue する |
| `WEBHOOK_BOOTSTRAP_SCAN_ENABLED=false`（デフォルト） | scan を行わない |

**動作詳細**:

- `LINEAR_API_KEY` が未設定の場合は scan をスキップします
- 取得対象: state が `unstarted`（Todo/Backlog）または `started`（In Progress）で、archived でない Issue（最大 50 件）
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

## 共通ログ

scheduler と webhook の両方が `docs/ai/auto_logs/auto_runner.log` へログを書き込む。

```
docs/ai/auto_logs/
  auto_runner.log   # 共通ログ（scheduler + webhook + run_auto.sh 出力）
  scheduler.log     # scheduler.sh の後方互換ログ（auto_runner.log と同内容）
  runner.lock       # プロセス間共通ロックファイル
  runner.queue.json    # 共通実行キューファイル（scheduler/webhook/Discord 統合）
  runner.cooldown.json # usage-limit cooldown 永続化ファイル
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

- `runner.runItem()` 実行前にロックを取得し、完了後に解放する
- ロック取得失敗時は Issue をキューに残し（または再投入し）、後続の drain で実行する
- SKIPPED_LOCKED は成功扱いしない
- ロックファイルのプロセスが死んでいる場合、または 30分以上経過した場合は stale lock として自動削除・再取得する
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

---

## Resume (Issue-Rerun)

中途で中断（usage-limit 等）されたタスクを、前回までのコンテキストを保持して再開する仕組みです。

- **実行**: `bash scripts/ai/run_auto.sh --resume` または Discord `/resume issue`
- **専用プロンプト**: `prompts/claude/auto_resume.md` を使用し、無駄な重複作業を避けます
- **メタデータ**: `docs/ai/auto_logs/resume/<issue>.json` に前回の終了理由、リセット時刻、Git 状態、ログの断片を記録します
- **チェックポイント**: ログに `[RESUME]` タグで再開ポイントを記録し、トレーサビリティを確保します
- **統合**: スケジューラー、Webhook、Discord、手動実行すべてがこの共通パスを使用します

---

## Session-Continue (Opt-in)

既存の tmux pane で実行中の Claude Code セッションに `continue` を送信する補助機能です。

- **実行**: `npm run resume:session -- --pane <pane> [--issue <id>]` または Discord `/resume session`
- **検証**: 送信前に pane が存在し、フォアグラウンドで Claude Code が動作しているか確認します。
- **待機状態**: usage-limit 中であれば `docs/ai/auto_logs/runner.session-continue.json` に `waiting` 状態を記録し、時刻まで待機します。
- **補完**: Issue-Rerun (Resume) を置き換えるものではなく、人間が手動で pane を開いている場合の補助として機能します。

---

## 共通実行キュー（runner.queue.json）
scheduler / webhook / Discord のすべての実行リクエストは共通キュー `docs/ai/auto_logs/runner.queue.json` を経由する。

- `runner.enqueue(issueId, trigger, retryAt)` でキューに追加（重複排除・更新）
- `runner.drainQueue()` でキューを順次処理（MAX 20件/回）
- キューはプロセス再起動後も永続化される
- 同一 Issue が複数回登録されても1件にまとめられ、retryAt は早い方が優先される
- `reason=usage_limit` で投入されたアイテムは、`run_auto.sh --resume` モードで実行されます
- scheduler 起動時にキューに残件があれば自動で drain される（再起動復旧）

### キュークリーンアップ

キューには以下の自動クリーンアップ機能がある:

- **normalizeQueue()**: `drainQueue()` 開始時に実行し、同一 `issueId` の重複エントリを1件に統合する（retryAt の早い方を優先）
- **syncQueueWithLinear()**: 起動時 bootstrap scan の drain 前に実行し、Linear API でキュー内 issue の状態を確認し、terminal / archived / not-found の issue をキューから削除する（API 失敗時は fail-open で削除しない）
- **pruneExpiredQueueItems()**: `drainQueue()` 開始時に実行し、`QUEUE_ITEM_TTL_DAYS`（デフォルト7日）を超えた古い item を対象に Linear で状態確認し、terminal / archived / not-found であれば削除する（active な issue は TTL を過ぎても削除しない）

環境変数 `QUEUE_ITEM_TTL_DAYS` で TTL 日数を変更できる（デフォルト: `7`）。

### in-flight tracking

実行中の issue は `docs/ai/auto_logs/runner.inflight.json` に issueId のリストとして記録される。

- `drainQueue()` が `runItem()` を呼ぶ前に `addInflight(issueId)` を実行し、finally で `removeInflight(issueId)` を実行する
- Webhook 受信時の重複チェックは `isQueuedOrRunning(issueId)` で行い、キュー内 AND 実行中の両方を対象にする
- プロセス再起動時に stale な inflight ファイルが残る場合があるが、キュー正規化・Linear 状態確認によりその issue の再実行可否を判断する

### Webhook event dedupe

Linear からの Webhook 再送を防ぐため、受信イベントを `docs/ai/auto_logs/linear.webhook-events.json` に記録する。

- event key は `body.id`（Linear 付与のユニーク ID）を使用する。未設定の場合は `type + action + issueId + updatedAt` の SHA-256 hash を使用する
- 同一 key を1時間以内に再受信した場合は `ignored: duplicate event` として処理をスキップする
- 1時間を超えたエントリは次回読み込み時に自動的にパージされる

## Queue 処理順序

webhook / startup-scan / Discord retry / scheduler の共通 queue は以下の優先順で処理されます。

### 優先順位ルール

1. **実行対象**: `retryAt` 未設定、または `retryAt` が現在時刻以前の item のみ実行
2. **Linear priority 順**（priorityRank 昇順）:
   - Urgent (priority=1) → rank 1（最優先）
   - High (priority=2) → rank 2
   - Medium (priority=3) → rank 3
   - Low (priority=4) → rank 4
   - No priority (priority=0) → rank 5（最後）
   - 未設定 (null/undefined) → rank 5（最後）
   - **注意**: No priority (0) は最優先ではなく最後に処理されます
3. **親子 group 優先**: 直前に処理した親Issueの子Issueが queue にある場合、次に優先して実行
   - Urgent は子Issue group より常に優先
   - 子Issue group 内では priorityRank → queueGroupOrder → enqueuedAt の順
4. **同 priority 内**: retryAt (早い順・null 優先) → enqueuedAt (早い順)

### 親Issue / 子Issue の関係

- 親Issueの実行中または直後に作成・登録された子Issueは、`queueGroup = 親IssueId` で紐付けられます
- 親Issue完了後、同じ `queueGroup` の子Issueが queue にあれば次の drain で優先的に選ばれます
- 複数の子Issueがある場合は `queueGroupOrder` (Linear createdAt 順) → `enqueuedAt` 順で処理されます

### その他のルール

- 実行中タスクは強制中断しません（drain は完了後に次 item を選択）
- `retryAt` 未到達の item は priority が高くても実行されません
- completed / canceled / archived Issue は queue に入っていても実行されません
- queue ファイル (`runner.queue.json`) の更新はアトミック書き込み (tmp → rename) で行います

## ロック取得失敗時の扱い

scheduler / webhook / Discord のいずれも共通の挙動:

- `SKIPPED_LOCKED` としてログに出力
- Issue はキューに残り（または再投入され）、ロック解放後の drain で自動実行される
- `run_auto.sh` が処理を完了していない場合に "completed successfully" を出力しない

## retryAt の仕様

- `retryAt` が null の場合は即座に実行可能
- `retryAt` が将来時刻の場合はその時刻以降に実行
- usage-limit cooldown 中の enqueue は cooldown 解除時刻を retryAt に設定

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

> **このプロジェクトの設定例（ngrok固定URL使用時）:**
>
> - Webhook サーバー起動: `npm run dev:webhook`
> - Interactions Endpoint URL: `https://elitism-unnerving-gallstone.ngrok-free.dev/webhooks/discord`
>
> ngrok URL が変わった場合は後述の「ngrok URL 変更時の更新箇所」を参照。

### 4. スラッシュコマンドを登録

```bash
node scripts/register_discord_commands.js
```

> **注意:** コマンドの追加・変更時は再度実行することで上書き登録される（既存コマンドと重複しても安全）。
> グローバルコマンドの反映には最大1時間かかる場合がある。

### 5. Bot をサーバーに招待

1. Discord Developer Portal の「OAuth2」→「URL Generator」
2. Scopes: `bot`, `applications.commands` を選択
3. Bot Permissions: `Send Messages` を選択
4. 生成されたURLでサーバーに招待

#### Bot 招待URL の例

以下の URL テンプレートの `<DISCORD_APPLICATION_ID>` を実際の Application ID に置き換えてアクセスする:

```
https://discord.com/oauth2/authorize?client_id=<DISCORD_APPLICATION_ID>&permissions=2048&scope=bot%20applications.commands
```

必要な権限:

- `bot` scope — Botとしてサーバーに参加
- `applications.commands` scope — スラッシュコマンドを登録・使用
- Bot Permission: `Send Messages` (permission value: 2048)

### 利用可能なコマンド

| コマンド                                  | 説明                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `/status`                                 | 実行中Issue、ロック、キュー、cooldown、**session-continue 待機状態**を表示 |
| `/queue`                                  | 実行キューの内容を表示                                                   |
| `/cooldown`                               | usage-limit cooldown状態（**種別含む**）を表示                          |
| `/pause`                                  | 新規実行を一時停止                                                       |
| `/resume pause`                           | 一時停止を解除（従来の `/resume`）                                       |
| `/resume issue id:SOT-xxx`                | 指定 Issue を再開モードで再実行キューへ投入                              |
| `/resume session pane:%1 [issue:SOT-xxx]` | tmux pane のセッションに continue を送信                                 |
| `/reply issue:SOT-xxx body:...`           | 指定IssueへLinearコメントを投稿                                          |
| `/retry issue:SOT-xxx`                    | 指定Issueを再実行キューへ投入                                            |
| `/ask`                                    | 自然言語で質問・指示（モーダルが開く）                                    |

### ngrok URL が変わった場合の更新箇所

ngrok の URL が変わった場合（有料プラン固定URL使用時は不要）、以下の箇所を更新する:

| 更新箇所                      | 内容                                                                |
| ----------------------------- | ------------------------------------------------------------------- |
| Discord Developer Portal      | General Information → Interactions Endpoint URL を新しい URL に更新 |
| Linear Webhook 設定           | Settings → API → Webhooks の URL を更新（Linear 側）                |
| `.env` の `NGROK_COMMAND`     | ngrok コマンドの URL 部分を更新                                     |
| `.env` の `NGROK_WEBHOOK_URL` | 確認用 URL を更新                                                   |

Discord の Interactions Endpoint URL は `https://<新しいURL>/webhooks/discord` になる。
Linear の Webhook URL は `https://<新しいURL>/webhooks/linear` になる。

## 環境変数リファレンス

| 変数                | 必須 | デフォルト   | 説明                                                              |
| ------------------- | ---- | ------------ | ----------------------------------------------------------------- |
| `LINEAR_API_KEY`    | 任意 | なし         | Linear Personal API Token。設定するとポーリングモードが有効になる |
| `ANTHROPIC_API_KEY` | 必須 | なし         | Anthropic API キー。Claude Code の動作に必要                      |
| `CHECK_INTERVAL`    | 任意 | `60`         | Linear ポーリング間隔（秒）                                       |
| `INTERVAL`          | 任意 | `3600`       | フォールバック実行間隔（秒）                                      |
| `TZ`                | 任意 | システム依存 | ログや実行環境のタイムゾーン（例: `Asia/Tokyo`）                  |

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

| ログプレフィックス | 意味                                         |
| ------------------ | -------------------------------------------- |
| `[WEBHOOK:PARENT]` | Webhook サーバー本体（親プロセス）のイベント |
| `[RUN:<issueId>]`  | 子プロセスの標準出力・エラー出力             |
| `[WEBHOOK]`        | Webhook 受信・処理ログ                       |

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

---

## 共通Firebase認証管理

ai-dev-control-plane に共通認証スクリプトが含まれています。
Firebase Authentication ユーザー管理と、Cloud Run への認証環境変数同期を一元管理します。

### ⚠️ セキュリティポリシー

- **パスワードは Linear Issue、README、.env.example、ログ、Git 履歴に残さないこと**
- パスワードはターミナルでのみ対話入力し、入力時は非表示（マスク）になります
- Firebase ユーザー作成後、パスワードは保存されず Firebase Auth にのみ反映されます

### Firebase Console での初回作業（人間が1度だけ実施）

以下は自動化できないため、人間が Firebase Console で直接作業してください：

1. **Firebase プロジェクトを確認または作成**
   - https://console.firebase.google.com/
   - project name:sota-app-hub

2. **Email/Password プロバイダを有効化**
   - Firebase Console > Authentication > Sign-in method
   - 「メール/パスワード」を有効化

3. **Web アプリの設定値を取得**
   - Firebase Console > プロジェクトの設定 > マイアプリ
   - 以下の値を控える:
     - `NEXT_PUBLIC_FIREBASE_API_KEY`
     - `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
     - `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
     - `NEXT_PUBLIC_FIREBASE_APP_ID`

4. **Authentication ユーザーを作成**
   - Email/Password でログインするユーザーを作成する
   - **方法A（推奨）**: `npm run auth:setup` → メニュー `1` を選択してターミナルから作成
   - **方法B（手動）**: Firebase Console > Authentication > Users > ユーザーを追加
   - 作成したユーザーのメールアドレスを `ALLOWED_USER_EMAILS` に追加すること

### セットアップ手順

```bash
# 1. Firebase プロジェクト ID を設定
export FIREBASE_PROJECT_ID=your-firebase-project-id

# 2. gcloud 認証（Cloud Run 更新に必要）
gcloud auth application-default login --no-launch-browser

# 3. 対話型セットアップを起動
npm run auth:setup
```

セットアップメニュー:

- `1` — Firebase ユーザー作成/更新（ターミナルでパスワードを入力）
- `2` — Cloud Run 認証環境変数を同期（ALLOWED_USER_EMAILS + Firebase 設定）
- `3` — 両方実行
- `4` — 設定状況確認
- `0` — 終了

### アプリ設定ファイル

`config/auth/apps.json` に全アプリの Cloud Run サービス名・リージョン・認証設定が記載されています。

Firebase Auth 移行済みかつ Cloud Run sync 設定が完了したアプリのみ `"cloudRunSyncEnabled": true` になっています。
移行完了後に `cloudRunSyncEnabled` を `true` に変更し、`npm run auth:setup` を実行してください。

### 移行状況

各アプリの詳細な認証移行手順は [`docs/auth/migration-plan.md`](docs/auth/migration-plan.md) を参照してください。

| アプリ                    | 現在の認証方式                    | Firebase Auth 移行         | Cloud Run sync | 備考                                           |
| ------------------------- | --------------------------------- | :------------------------: | :------------: | ---------------------------------------------- |
| english-phrase-trainer    | Firebase Auth + Cookie            |       ✅ 移行済み          |       ✅       | 基準実装                                       |
| stock-signal-research     | Firebase Auth + Cookie            |       ✅ 移行済み          |       ❌       | Cloud Run サービス名: `stock-signal-service`   |
| state-machine-simulator   | Firebase Auth + Cookie            |       ✅ 移行済み          |       ❌       |                                                |
| shrine-stair-trainer      | Firebase Auth（フロントのみ）     | ✅ 移行済み（フロントのみ） |       ❌       | 静的フロント。サーバー側検証なし。AUTH_SECRET不要 |
| kindle-sale-monitor       | Firebase Auth + Cookie            |       ✅ 移行済み          |       ❌       | /run は Cloud Scheduler 専用（OIDC）           |
| booking-monitor           | Firebase Auth + Cookie            |       ✅ 移行済み          |       ❌       | /run は Cloud Scheduler 専用（OIDC）           |
| toddler-nas-photo-indexer | Firebase Auth + Cookie            |       ✅ 移行済み          |       ❌       |                                                |
| toddler-private-rag       | Firebase Auth（部分実装）         |       ✅ 移行済み          |       ❌       |                                                |
