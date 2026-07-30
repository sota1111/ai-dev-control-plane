# 環境変数リファレンス

| 変数                | 必須 | デフォルト   | 説明                                                              |
| ------------------- | ---- | ------------ | ----------------------------------------------------------------- |
| `LINEAR_API_KEY`    | 任意 | なし         | Linear Personal API Token。設定するとポーリングモードが有効になる |
| `ANTHROPIC_API_KEY` | 必須 | なし         | Anthropic API キー。Claude Code の動作に必要                      |
| `CHECK_INTERVAL`    | 任意 | `60`         | Linear ポーリング間隔（秒）                                       |
| `INTERVAL`          | 任意 | `3600`       | フォールバック実行間隔（秒）                                      |
| `TZ`                | 任意 | システム依存 | ログや実行環境のタイムゾーン（例: `Asia/Tokyo`）                  |

> Webhook モード固有の環境変数（`WEBHOOK_MODE` / `PORT` / `LINEAR_WEBHOOK_SECRET` / `NGROK_COMMAND` / `NGROK_WEBHOOK_URL`）は [`webhook.md`](./webhook.md#環境変数webhook-モード) を、usage-limit 関連（`USAGE_LIMIT_RETRY_BUFFER_SECONDS` / `OVERLOAD_RETRY_BUFFER_SECONDS`）は [`usage-limit-and-resume.md`](./usage-limit-and-resume.md#環境変数) を、`QUEUE_ITEM_TTL_DAYS` は [`runner-queue.md`](./runner-queue.md#キュークリーンアップ) を参照。

## ワーカーディスパッチ / ロールパイプライン

ワーカー選択の唯一の上位スイッチは env ではなく **`config/worker_roles.json`**（役割 → 優先度チェーン）。
以下はディスパッチ/パイプラインの挙動を調整する env。詳細は [`runner-queue.md`](./runner-queue.md) と `CLAUDE.md`。

| 変数                       | 必須 | デフォルト | 説明                                                                                                    |
| -------------------------- | ---- | ---------- | ------------------------------------------------------------------------------------------------------- |
| `PIPELINE_GRAPH_FILE`      | 任意 | `config/pipeline_graph.json` | 単一実行モデルで使用するグラフ設定を上書きする。無効な設定は安全に停止する |
| `PIPELINE_MAX_DEBUG_CYCLES`| 任意 | `2`        | verification/acceptance が `NEEDS_DEBUG` のとき implementation へループバックする最大回数                |
| `WORKER_SESSION_REUSE`     | 任意 | `1`（有効）| `0/false/no/off` で同一ワーカー連続時のセッション再利用（会話キャッシュ温存）を無効化                    |
| `ANTIGRAVITY_DISABLED`     | 任意 | 無効       | 真値で Antigravity worker を一時停止（`run_antigravity.sh` が `75` で終了 → 次候補へ引き継ぎ）           |
| `CODEX_DISABLED`           | 任意 | 無効       | 真値で Codex worker を一時停止（`run_codex.sh` が `75`）                                                 |
| `CLAUDE_DISABLED`          | 任意 | 無効       | 真値で委譲 Claude worker を一時停止（`run_claude.sh` が `75`）                                           |

> 廃止済み: グローバル env kill-switch `ALL_CLAUDE_MODE` / `WORKER_MODE`（`config/worker_roles.json` に統合）。
> 全作業を Claude で回すには全役割を `["claude"]` に設定する。真値は `1/true/yes/on`（大小無視）。

## 秘密情報の管理

- `.env` はGit管理しない（`.gitignore` で除外済み）
- `.env.example` には実際のAPIキーやトークンを記入しない
- APIキー、トークン、認証情報はログやREADMEに出力しない
- 誤って秘密情報をコミットした場合は、すぐに値を無効化・再発行すること
