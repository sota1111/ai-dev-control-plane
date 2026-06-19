# Discord Bot セットアップ

## 1. Discord Application 作成

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス
2. 「New Application」をクリックし、アプリ名を入力
3. 左メニューの「Bot」→「Add Bot」をクリック
4. 「Reset Token」でBot Tokenを取得（一度しか表示されないので保存）
5. 左メニューの「General Information」から Application ID と Public Key を取得

## 2. 環境変数を設定

`.env` ファイルに以下を追加:

```env
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_APPLICATION_ID=your_application_id_here
DISCORD_PUBLIC_KEY=your_public_key_here
```

## 3. Interactions Endpoint URL を設定

1. ngrok などでサーバーを公開: `npm run dev:webhook`
2. Discord Developer Portal の「General Information」→「Interactions Endpoint URL」に `https://your-domain.ngrok.io/webhooks/discord` を設定
3. Discordが検証リクエストを送信し、成功すれば設定完了

> **このプロジェクトの設定例（ngrok固定URL使用時）:**
>
> - Webhook サーバー起動: `npm run dev:webhook`
> - Interactions Endpoint URL: `https://elitism-unnerving-gallstone.ngrok-free.dev/webhooks/discord`
>
> ngrok URL が変わった場合は後述の「ngrok URL が変わった場合の更新箇所」を参照。

## 4. スラッシュコマンドを登録

```bash
node scripts/register_discord_commands.js
```

> **注意:** コマンドの追加・変更時は再度実行することで上書き登録される（既存コマンドと重複しても安全）。

### 反映スコープ（global vs guild）

スクリプトは `DISCORD_GUILD_ID` の有無で登録先を切り替える:

| `DISCORD_GUILD_ID` | 登録先 | 反映タイミング |
| ------------------ | ------ | -------------- |
| 未設定             | グローバル（全サーバー） | **最大1時間**かかる（Discord仕様） |
| 設定済み           | そのサーバー（guild）のみ | **即時** |

新しいコマンドが Discord に出てこない場合、まず原因はこの**グローバル登録の伝播待ち＋クライアントのキャッシュ**であることが多い。対処:

1. **即時反映したい** → `.env` に `DISCORD_GUILD_ID`（サーバーID）を設定して再登録する。
   - サーバーID取得: Discord > ユーザー設定 > 詳細設定 > 開発者モードON → サーバーアイコン右クリック > 「サーバーIDをコピー」
2. **グローバルのまま待つ** → Discord クライアントを再起動/更新（デスクトップは `Ctrl+R`）してキャッシュを更新し、最大1時間待つ。

> 登録が成功しているかは Discord API で確認できる:
> `GET https://discord.com/api/v10/applications/<APP_ID>/commands`（Bot トークン認証）。
> ここに出ていれば登録自体は完了しており、表示されないのはクライアント側の反映遅延。

## 5. Bot をサーバーに招待

1. Discord Developer Portal の「OAuth2」→「URL Generator」
2. Scopes: `bot`, `applications.commands` を選択
3. Bot Permissions: `Send Messages` を選択
4. 生成されたURLでサーバーに招待

### Bot 招待URL の例

以下の URL テンプレートの `<DISCORD_APPLICATION_ID>` を実際の Application ID に置き換えてアクセスする:

```
https://discord.com/oauth2/authorize?client_id=<DISCORD_APPLICATION_ID>&permissions=2048&scope=bot%20applications.commands
```

必要な権限:

- `bot` scope — Botとしてサーバーに参加
- `applications.commands` scope — スラッシュコマンドを登録・使用
- Bot Permission: `Send Messages` (permission value: 2048)

## 利用可能なコマンド

| コマンド                                  | 説明                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `/status`                                 | 実行中Issue、ロック、キュー、cooldown、**session-continue 待機状態**を表示 |
| `/queue`                                  | 実行キューの内容を表示                                                   |
| `/pastqueue`                              | 直近10件の過去キュー（処理済みIssue）を `/queue` と同じ形式で表示          |
| `/reorder`                                | Todo+In Progress を取得し、実行キューを優先度順に再構築                   |
| `/cooldown`                               | usage-limit cooldown状態（**種別含む**）を表示                          |
| `/pause`                                  | 新規実行を一時停止                                                       |
| `/resume pause`                           | 一時停止を解除（従来の `/resume`）                                       |
| `/resume issue id:SOT-xxx`                | 指定 Issue を再開モードで再実行キューへ投入                              |
| `/resume session pane:%1 [issue:SOT-xxx]` | tmux pane のセッションに continue を送信                                 |
| `/reply issue:SOT-xxx body:...`           | 指定IssueへLinearコメントを投稿                                          |
| `/retry issue:SOT-xxx`                    | 指定Issueを再実行キューへ投入                                            |
| `/recover`                                | 停止した自動実行を強制復帰（cooldown/pause解除・stale inflight回収・Linear再スキャン・ドレイン） |
| `/recover force:true`                     | 上記に加え `runner.lock` を強制解放し inflight/current-issue も強制クリア（生存だが固まったロック向け） |
| `/ask`                                    | 自然言語で質問・指示（モーダルが開く）                                    |

### `/recover` の使い分け

自動実行が何らかの要因で止まったときの復帰用コマンド。

- **まず `/recover`（soft）を試す。** usage-limit cooldown の居残り、`/pause` のかけっぱなし、leaked inflight、webhook 取りこぼし、終端Issueの居残りといった「止まる」主因をまとめて解消し、Linear の actionable Issue（Todo / In Progress、**In Review は除外**）を再投入してドレインを起動する。副作用が安全な操作のみ。
- **それでも動かない（ロックが固着している）場合に `/recover force:true`。** 実行ロックの保持プロセスが「生存しているが固まっている」ケース向け。`run_auto.sh` の OS flock が実際の二重起動を防ぐため、JSロックの強制解放は比較的安全。
  - なお dead/stale なロックは通常の実行時に自動回収されるため、force が要るのは稀。

## ngrok URL が変わった場合の更新箇所

ngrok の URL が変わった場合（有料プラン固定URL使用時は不要）、以下の箇所を更新する:

| 更新箇所                      | 内容                                                                |
| ----------------------------- | ------------------------------------------------------------------- |
| Discord Developer Portal      | General Information → Interactions Endpoint URL を新しい URL に更新 |
| Linear Webhook 設定           | Settings → API → Webhooks の URL を更新（Linear 側）                |
| `.env` の `NGROK_COMMAND`     | ngrok コマンドの URL 部分を更新                                     |
| `.env` の `NGROK_WEBHOOK_URL` | 確認用 URL を更新                                                   |

Discord の Interactions Endpoint URL は `https://<新しいURL>/webhooks/discord` になる。
Linear の Webhook URL は `https://<新しいURL>/webhooks/linear` になる。
