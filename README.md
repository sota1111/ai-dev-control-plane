# ai-dev-control-plane

**AI 開発オーケストレーションの「管制塔（control plane）」**。
人間は Linear / Discord から指示を出すだけで、ハーネスが各ロール（タスク確認・分解・実装・検証・受け入れ・GitHub・Linear報告）を **個別に設定したワーカー**（Claude / Codex / Antigravity）へディスパッチし、実装・検証・PR 作成・マージまでを自律的に回す。単一の「唯一のオーケストレータ」は存在しない。

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

1. **人間の窓口は Linear / Discord（Single Interface）**
   人間が指示を出す先は **Linear / Discord** に一本化する。Claude / Codex / Antigravity といったワーカー CLI へ人間が直接話しかけることはない。どのワーカーが何を担当するかはハーネスが設定に従って自動で振り分ける。

2. **役割ごとに担当ワーカーを個別設定（Per-Role Assignment）**
   各ロール（task-check / decomposition / implementation / verification / acceptance / github / linear-report）は `config/worker_roles.json` の **優先度チェーン**で個別にワーカーへ割り当てる。ディスパッチャ `scripts/ai/run_worker.sh` が選択・フォールバックを担い、対象 issue では `run_auto.sh` が全工程をスクリプトとして順に駆動する。単一の「全体を統括するオーケストレータ」は置かない（Claude はチェーンが選んだロールのワーカーとして参加する）。

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
   run_auto.sh（スクリプト駆動ロールパイプライン）
        │  各ロールを run_worker.sh <role> にディスパッチ
        │  （担当ワーカーは config/worker_roles.json の優先度チェーンで個別設定）
        ├─ task-check / verification … 既定 Codex
        ├─ implementation … 既定 Antigravity（非応答時はチェーンで次候補へ）
        ├─ decomposition / acceptance / github / linear-report … 既定 Claude
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
        │                               │ runner.ts が issue を選び WEBHOOK_ISSUE_ID を注入
        │                   ┌───────────▼─────────────────────────────┐
        └───────────────────│  run_auto.sh — スクリプト駆動パイプライン │  工程順序はスクリプトが確定駆動
                            │  task-check→decomposition→implementation │
                            │  →verification→acceptance→github→report  │
                            └───────────────┬─────────────────────────┘
                                            │ 各ロールごとに
                                 ┌──────────▼───────────┐
                                 │  run_worker.sh <role> │  ディスパッチャ（唯一の入口）
                                 │  config/worker_roles  │  優先度チェーンで worker 選択
                                 │  .json のチェーンを読む │  非応答(75)→次候補へ引き継ぎ
                                 └──┬────────┬────────┬──┘
                          run_codex │  run_claude │ run_antigravity
                        ┌───────────▼┐ ┌────────▼┐ ┌▼──────────────┐
                        │  Codex CLI  │ │ Claude  │ │ Antigravity   │
                        │  検証/確認  │ │ worker  │ │ CLI 実装      │
                        └─────────────┘ └─────────┘ └───────────────┘
                                            │ PR / commit / merge（github ロール）
                                     ┌──────▼──────┐
                                     │   GitHub     │  成果物・変更履歴
                                     └─────────────┘
```

主要コンポーネント:

| コンポーネント       | 役割                                 | 実体                                      |
| -------------------- | ------------------------------------ | ----------------------------------------- |
| **自律実行パイプライン** | 対象 issue の全工程を順次駆動（案B） | `scripts/ai/run_auto.sh`                  |
| **ワーカーディスパッチャ** | 役割ごとに優先度チェーンで worker を選択・フォールバック | `scripts/ai/run_worker.sh`         |
| **Antigravity CLI**  | 実装ワーカー                         | `scripts/ai/run_antigravity.sh`           |
| **Codex CLI**        | デバッグ・検証ワーカー               | `scripts/ai/run_codex.sh`                 |
| **Claude worker**    | 委譲された Claude ワーカー（チェーンが claude を選んだとき） | `scripts/ai/run_claude.sh`   |
| **役割割当**         | 各役割 → 優先度チェーン（唯一の上位スイッチ） | `config/worker_roles.json`            |
| **役割プロンプト**   | ロール別・worker 非依存の指示（committed 静的） | `prompts/roles/<role>.md`          |
| **スケジューラー**   | Linear をポーリングして起動          | `scripts/ai/scheduler.sh`                 |
| **Webhook サーバー** | Linear/Discord イベントで即時起動    | `src/webhook-server.ts`                   |
| **Discord Bot**      | 遠隔での状態確認・制御               | `src/lib/discord*.ts`                     |
| **Linear**           | 指示・進捗・状態の管理場所           | 外部 SaaS（MCP / API / Webhook 連携）     |
| **GitHub**           | 成果物・履歴の保管庫                 | 外部 SaaS（`gh` CLI 連携）                |

> **対象アプリの実装場所**: 実装対象のプロジェクトは `/workspaces/<project-name>` にクローンして作業する。この管理プレーン（ai-dev-control-plane）自身は「オーケストレーション基盤」であり、各アプリのコードは含まない。詳細は [`CLAUDE.md`](./CLAUDE.md) の Development Environment を参照。

---

## 役割分担

| 担当            | やること                                                                                 | やらないこと                                                         |
| --------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Claude worker** | 方針整理・分解判断・受け入れ確認・GitHub 操作・Linear 同期（役割の worker として委譲実行）| チェーンで claude 以外が選ばれた役割の実行                           |
| **Antigravity CLI**  | 機能実装・UI/API/ビジネスロジック作成（implementation ロール）                        | スコープ外のリファクタ・設計変更                                     |
| **Codex CLI**   | lint/typecheck/test 実行・原因特定・最小修正・E2E 検証（task-check / verification ロール）| スコープ拡大・無関係なリファクタ                                     |

### ロールパイプライン & ディスパッチ（案B / 既定）

対象 issue が確定した autonomous run では、**`run_auto.sh` 自身がスクリプトとして全工程を順次駆動**する
（AI が単一オーケストレータとして全体を統括しない）。工程順:
**task-check → decomposition → implementation → verification → acceptance → github → linear-report**。

- 各ロールは **`scripts/ai/run_worker.sh <role>`**（唯一の入口）に委譲。ディスパッチャが
  `config/worker_roles.json` の**優先度チェーン**で worker を選び、非応答（exit 75）/ usage-limit なら
  部分レポートを渡して次候補へ引き継ぐ。役割の指示は committed な `prompts/roles/<role>.md`。
- `run_auto.sh` は各ロール後に勝者レポートの `## Next Action` でゲート判定する:
  task-check が非アクション→成功 no-op で停止 / verification・acceptance の `NEEDS_DEBUG`→implementation へ
  ループ（上限 `PIPELINE_MAX_DEBUG_CYCLES`、既定 2）/ `BLOCKED`・チェーン全滅→停止（exit 70、要人間）。
- `PIPELINE_MODE=0` または issue 未指定（手動キュー走査）は、レガシーの単一 Claude オーケストレータ起動へ退避。

**Linear からの per-issue worker 指定**: issue の説明文またはコメントに `workers: role=worker[, ...]` の
1 行を書くと、その issue のパイプラインだけ担当 worker を上書きできる（書かないロールは既定チェーン）。

```
workers: implementation=codex, verification=claude
```

- ロール: task-check / decomposition / implementation / verification / acceptance / github / linear-report
- worker: claude / codex / antigravity（別名 `agy`）。フォールバックは `>` 区切り（例 `implementation=codex>claude`）
- 説明文でもコメントでも可。同じロールは**最新の記述が優先**。パイプライン開始時に `run_auto.sh` が
  `runner-cli resolve-worker-roles` で解決し、`WORKER_ROLES_FILE` として全 `run_worker.sh` に適用する。

**Linear 記述サンプル**

issue 説明文に直接書く例（他の本文と混在してよい。`workers:` の行だけが解釈される）:

```text
## 目的
ログイン画面のバグを修正する

## 補足
- 実装は Codex に任せ、検証も Codex で通したい
workers: implementation=codex, verification=codex
```

後からコメントで担当を切り替える例（最新の記述が優先されるので、実行前ならコメント追記で上書き可）:

```text
implementation が antigravity で詰まったので claude に切り替えます。
workers: implementation=claude
```

フォールバック付き（第一候補 codex、ダメなら claude）や複数ロール指定の例:

```text
workers: implementation=codex>claude, verification=codex, github=claude
```

7 ロール全てを 1 行でまとめて明示指定する例（この issue のパイプライン全工程の担当 worker を確定させる）:

```text
workers: task-check=codex, decomposition=claude, implementation=antigravity, verification=codex, acceptance=claude, github=claude, linear-report=claude
```

複数行に分けても同じ（各行の `workers:` が積算され、同じロールは最後の行が優先）:

```text
workers: task-check=codex, decomposition=claude, implementation=antigravity
workers: verification=codex, acceptance=claude
workers: github=claude, linear-report=claude
```

> 書かなかったロールは `config/worker_roles.json` の既定チェーンのまま。`workers:` 行が無ければ完全に既定動作。

詳細は [`CLAUDE.md`](./CLAUDE.md) の「Worker Dispatch」節、および [`docs/runner-queue.md`](./docs/runner-queue.md) を参照。

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

どのワーカーが各役割を担当するかは、**`config/worker_roles.json` が唯一の上位スイッチ**である。各役割は
**順序付きの優先度チェーン**（例: `"task-check": ["codex","claude","antigravity"]`。先頭=第一候補、以降=
フォールバック順）にワーカーを割り当てる。ディスパッチャ `scripts/ai/run_worker.sh <role>` がこのチェーンを
読み、先頭から順にワーカーの run スクリプト（`run_codex.sh` / `run_claude.sh` / `run_antigravity.sh`）を起動し、
**非応答（exit 75）や usage-limit なら次の候補へ引き継ぐ**（部分レポートを渡して継続）。**AI が AI を直接呼ばず、
必ずこのスクリプトを噛ませる**のが原則。同一ワーカーが連続する場合はその CLI の会話セッションを再利用して
プロンプトキャッシュを温存する（claude=`--session-id`/`--resume`、codex=`exec resume --last`、
antigravity=`--continue`。`WORKER_SESSION_REUSE=0` で無効化、セッションは 1 run 単位で `run_auto.sh` 開始時に
リセット）。全作業を Claude だけで回すには
全役割を `["claude"]` に。かつてのグローバル env kill-switch `ALL_CLAUDE_MODE` / `WORKER_MODE` は廃止された。

以下の env フラグは、チェーン選択の**後**に各ワーカーの run スクリプト内で評価される「ワーカー一時停止
（worker is down）」用のエスケープハッチであり、役割割当を上書きしない。真値は `1` / `true` / `yes` / `on`（大小無視）。

| 変数               | 効果                                                                                                   | 用途                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `ANTIGRAVITY_DISABLED`  | Antigravity worker を一時停止（`run_antigravity.sh` が `75` で終了 → 次候補へ引き継ぎ）。                | Google のプラン変更等で Antigravity CLI が使えない期間          |
| `CODEX_DISABLED`   | Codex worker を一時停止（`run_codex.sh` が `75` で終了 → 次候補へ引き継ぎ）。                              | Codex CLI が使えない期間                                   |
| `CLAUDE_DISABLED`  | 委譲された Claude worker を一時停止（`run_claude.sh` が `75` で終了 → 次候補へ引き継ぎ）。                  | Claude worker を一時的に外したい期間                        |

いずれのフラグも、ワーカーを非応答コード `75` で終了させることでディスパッチャがチェーン内の次候補へ引き継ぐ。
チェーン全体が非応答（`WORKER_DISPATCH_EXHAUSTED`）のときのみ、[役割分担](#役割分担)の「ワーカー非応答時の
フォールバック」に基づき Claude Code が作業を代行する。

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
