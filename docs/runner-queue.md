# 共通実行キューとログ

scheduler / webhook / Discord の実行リクエストは共通の実行キューとロックを経由する。ここではキュー・処理順序・ロック・ログの仕様をまとめる。

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
- **完了コントラクト**: プロセスが exit 0 でも、Linear 上のステータスが `Done`/`completed` でない場合や、レポートに `NEEDS_DEBUG` 等が含まれる場合は未完了とみなします（`COMPLETION_UNVERIFIED=70`）。この場合、成功時のクリーンアップ（ラベル除去等）はスキップされます。

## retryAt の仕様

- `retryAt` が null の場合は即座に実行可能
- `retryAt` が将来時刻の場合はその時刻以降に実行
- usage-limit cooldown 中の enqueue は cooldown 解除時刻を retryAt に設定

## ログ

実行ログは `docs/ai/auto_logs/` に保存される。

```
docs/ai/auto_logs/scheduler.log   # スケジューラー動作ログ
docs/ai/auto_logs/run_*.log       # 各 Claude 実行ログ（run_auto.sh が生成、タイムスタンプ付き）
```
