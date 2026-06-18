# 環境変数リファレンス

| 変数                | 必須 | デフォルト   | 説明                                                              |
| ------------------- | ---- | ------------ | ----------------------------------------------------------------- |
| `LINEAR_API_KEY`    | 任意 | なし         | Linear Personal API Token。設定するとポーリングモードが有効になる |
| `ANTHROPIC_API_KEY` | 必須 | なし         | Anthropic API キー。Claude Code の動作に必要                      |
| `CHECK_INTERVAL`    | 任意 | `60`         | Linear ポーリング間隔（秒）                                       |
| `INTERVAL`          | 任意 | `3600`       | フォールバック実行間隔（秒）                                      |
| `TZ`                | 任意 | システム依存 | ログや実行環境のタイムゾーン（例: `Asia/Tokyo`）                  |

> Webhook モード固有の環境変数（`WEBHOOK_MODE` / `PORT` / `LINEAR_WEBHOOK_SECRET` / `NGROK_COMMAND` / `NGROK_WEBHOOK_URL`）は [`webhook.md`](./webhook.md#環境変数webhook-モード) を、usage-limit 関連（`USAGE_LIMIT_RETRY_BUFFER_SECONDS` / `OVERLOAD_RETRY_BUFFER_SECONDS`）は [`usage-limit-and-resume.md`](./usage-limit-and-resume.md#環境変数) を、`QUEUE_ITEM_TTL_DAYS` は [`runner-queue.md`](./runner-queue.md#キュークリーンアップ) を参照。

## 秘密情報の管理

- `.env` はGit管理しない（`.gitignore` で除外済み）
- `.env.example` には実際のAPIキーやトークンを記入しない
- APIキー、トークン、認証情報はログやREADMEに出力しない
- 誤って秘密情報をコミットした場合は、すぐに値を無効化・再発行すること
