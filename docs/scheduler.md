# スケジューラー

`scripts/ai/scheduler.sh` は `CHECK_INTERVAL` 秒ごとに Linear をポーリングし、対象状態の Issue を共通実行キューに enqueue して drain を実行する。

> 事前準備（`.env` の作成と各種認証）は README の [クイックスタート](../README.md#クイックスタート実行手順) を参照。

## 動作モード

### Linear ポーリングモード（推奨）

`LINEAR_API_KEY` が設定されている場合、`CHECK_INTERVAL` 秒ごとに Linear API をポーリングする。
Linear 上の Issue 状態タイプが `unstarted`（Todo）または `started`（In Progress）の Issue が存在する場合、各 Issue を `node src/runner-cli.js enqueue` でキューに追加し、`node src/runner-cli.js drain` で共通実行パイプラインを通じて処理する。`backlog`（Backlog）の Issue は対象外。
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
