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

## lane 並行 / デタッチ実行モデル（SOT-911 案②）

長時間 sim repo と細かい変更 repo を並行開発できるよう、実行を **lane**（レーン）単位に分離し、
長時間タスクは **デタッチ実行** する仕組みを導入している。Claude 利用上限は account-global のため、
この並列化は「Claude を専有しない待ち主体の処理（別 repo の sim 実行）」にのみ効く。

### lane 分離（RUNNER_LANE）

環境変数 `RUNNER_LANE` で lane を指定すると、lock / queue / ワーカー成果物が lane 別パスになる。
別 repo の作業を独立 lane で並行ドレインしても、互いの lock / queue / レポートを踏まない。

- `RUNNER_LANE` 未指定（= `default` lane）は **後方互換**: 従来の `runner.lock` / `runner.queue.json` を使う。
- 非 default lane は lane 名を挟んだ独立パス: `runner.<lane>.lock` / `runner.<lane>.queue.json`。
- lane 名は `[a-zA-Z0-9_-]` にサニタイズされ、`LOG_DIR` の外には出られない。
- ワーカー成果物（Gemini/Codex のレポート・プロンプト）も lane 別パス、`WORKER_TIMEOUT` は per-lane
  （long-run lane は長め）。詳細は `scripts/ai/run_gemini.sh` / `run_codex.sh`（SOT-916）。

### 直列スコープの切替（RUNNER_SERIALIZE_SCOPE / SOT-931, 案A）

書き込み側の直列（serialization）粒度は切替可能。環境変数 `RUNNER_SERIALIZE_SCOPE` で
lane キーの導出ルールを切り替える。これは案A（並行ワーカープール＋worktree レーン＋既定デタッチ）の
第一実装ステップで、`RUNNER_LANE` を明示しなくても repo/branch から lane を自動導出できるようにする。

- `repo`（**既定 / 現行互換**）: 同一 repo の全 branch が同一 lane を共有 → **同一 repo は直列**。
- `branch`: lane を `repo--branch` で導出。**同一 branch だけ直列／別 branch は別 lane（別 lock/queue）で並行可**。

導出は `resolveLane()` が次の優先順で行う（`src/runner.ts`）:

1. **明示 `RUNNER_LANE`（非 default）が最優先** — 従来の repo 単位 lane 割当（SOT-913）と後方互換を維持。
2. それ以外で `RUNNER_SERIALIZE_SCOPE=branch` のとき、`RUNNER_REPO` / `RUNNER_BRANCH` から
   `serializationLaneKey()` で lane を導出（別 branch → 別 lane）。
3. それ以外 → `default` lane（同一 repo 直列、現行どおり）。

lane キーは `[a-zA-Z0-9_-]` にサニタイズされ `LOG_DIR` の外に出られない。`branch` スコープでも
**同一 branch は必ず直列**（git/作業ツリー破損防止）を保つ。実際に同一 repo・別 branch を安全に並行
実行するための worktree 供給・N スロット並列プール・既定デタッチ化は後続の案A実装ステップで扱う。

### デタッチ実行（long-run ラベル）

Linear で `long-run` ラベルの付いた Issue は **デタッチ実行** される。重いプロセス（sim 等）が
JS のロックを長時間占有しないよう、起動直後にロックを解放する。

1. `runItem()` が `long-run` を検知 → `addInflight()` → `triggerRunDetached()` で
   `run_auto.sh` を切り離し起動 → `detached/<issue>.sentinel.json`（pid 記録）を書き、**即ロック解放**。
   inflight と sentinel は残し、reaper が後始末を担う。
2. デタッチ子プロセスは自分の log を `detached/<issue>.log` に書き、終了時に exit code を載せた
   done-marker `detached/<issue>.done.json` をアトミックに書く（親 JS は完了時に生存していなくてよい）。
3. `reapCompletedDetachedRuns()` が done-marker を検出し、共通の `processCompletedRun()` に結果を渡す:
   - 成功 → 成功クリーンアップ（usage-limit ラベル除去等）
   - usage-limit → cooldown 設定 + resume 再投入（`reason=usage_limit`）
   - 失敗 / 未検証 → ログのみ（成功クリーンアップはスキップ）
   - 後始末で done-marker / log / sentinel / inflight を削除。
4. PID が死んだのに sentinel が残った場合は `reapDeadDetachedSentinels()` が掃除する（クラッシュ復旧）。

### 既定デタッチ化（RUNNER_DEFAULT_DETACH / SOT-934, 案A 最終歩）

環境変数 `RUNNER_DEFAULT_DETACH` を有効（`1` / `true`）にすると、`long-run` ラベルの無い **通常 run も
デタッチ実行**される。`runItem()` のデタッチ分岐の条件が `isLongRun` から `isLongRun || RUNNER_DEFAULT_DETACH`
に一般化され、通常 run も上記 long-run と同じ `triggerRunDetached` → done-marker → `reapCompletedDetachedRuns()`
経路を通る。これにより webhook は run の完了を待たずロックを即解放（即 return）でき、supervisor/drain
（N スロットプール, SOT-933）が空きスロットへ次を流せる。

- **既定は `false`（無効）= 後方互換**: 通常 run は従来どおり同期（前景）パスで実行され、ロックを run 完了まで
  保持する。既存挙動と byte-for-byte 同一。段階導入用のフラグであり、有効化は明示的に行う。
- 有効時は全通常 run がデタッチされるため、完了後処理は reaper（`reapCompletedDetachedRuns()`）が担う
  （long-run と同じモデル）。`long-run` ラベルや SOT-925 の運用ルールとは非競合（isLongRun 分岐は維持）。

### 安定運用モード（RUNNER_STABLE_MODE / SOT-947）

環境変数 `RUNNER_STABLE_MODE` を有効（`1` / `true`）にすると、runner を **完全直列の「安定運用モード」**
に強制する単一マスタースイッチ。一時的に並列化を全停止したいときに、各トグルを個別に戻さず env 1 つで
切替えられる（可逆）。有効時、他のすべての並列/デタッチトグルは**直列側の値に上書き**される:

- `RUNNER_MAX_PARALLEL` → 強制 `1`（N スロット並列プール無効、`resolveMaxParallel` が先頭で 1 を返す）。
- `RUNNER_SERIALIZE_SCOPE` → 強制 `repo`（per-branch lane 無効、同一 repo は常に直列）。
- `RUNNER_DEFAULT_DETACH` → 強制 `false`（通常 run の既定デタッチ無効）。
- **`long-run` ラベルのデタッチも無効化**: `runItem()` の分岐が `isLongRun && !stableMode` で gate され、
  `long-run` ラベル付き Issue も同期（前景）パスで実行される。上記トグルと独立に常時 ON だった唯一の
  並列経路を塞ぐため、これが安定運用モードの肝。

- **既定は `false`（無効）= 後方互換**: 未設定時は各トグルが従来どおり動作し、挙動は byte-for-byte 同一。
- lane / worktree / reaper の実行基盤自体は温存される（パスや関数は変更なし）。env を外せば即座に元の
  並列/デタッチ挙動へ戻る。
- 注意: 有効時は `long-run` の待機/長時間タスクも前景同期で走るため、SOT-925 の「wall-clock 膨張」トレード
  オフが復活する。安定性を優先して並列を一時停止する目的のフラグであり、恒常設定ではない。

### 全Claude担当モード（ALL_CLAUDE_MODE / SOT-993）

環境変数 `ALL_CLAUDE_MODE` を真値（`1` / `true` / `yes` / `on`、大小無視）にすると、`scripts/ai/run_gemini.sh`
と `scripts/ai/run_codex.sh` の**両方**が CLI を起動せずワーカー非応答コード `75` で即終了する。これにより
CLAUDE.md「Worker Non-Response Fallback Policy」が発動し、**実装も検証も Claude Code が直接担当する**。

- `GEMINI_DISABLED`（Gemini のみ無効化）の上位版であり、Codex も含めて全ワーカー委譲を停止する単一マスター
  スイッチ。Claude のプラン変更等で全作業を Claude に寄せたいときに env 1 つで切替えられる（可逆）。
- 評価順は両スクリプトとも `WORKER_NONRESPONSE_EXIT=75` 定義直後、`GEMINI_DISABLED` / cooldown pre-check の
  **前**。最初の意図的短絡として効く。
- **既定は無効 = 後方互換**。未設定時は両ワーカーが従来どおり起動する。`RUNNER_STABLE_MODE`（並列の停止）とは
  直交する別軸のフラグ（こちらはワーカー委譲そのものの停止）。

### 運用ルール: 待機 / 長時間タスクは `long-run` を付ける（SOT-925）

**待機タスク（ScheduleWakeup 等で待つ）や長時間タスクには必ず `long-run` ラベルを付け、デタッチ実行に
乗せること。** 非 `long-run` の待機/長時間タスクは同期パスで実行され、待っている間ずっと単一 lane
（グローバル flock）を占有する。これは設計（同一 lane は Claude 単線・直列）上の以下の弊害を生む:

- **wall-clock 膨張**: 後続タスクが lane の解放を待ち、1分待機の実行開始まで数十分かかる等、実時間が
  要件を大きく超過する。
- **取り残し / 再開漏れ**: 同期パスの待機は実行プロセスのライフサイクルを跨いで再開されにくく、
  Issue が In Progress のまま完了しないことがある（SOT-921 / SOT-922 の事例）。

`long-run` を付けるとデタッチ実行になり、起動直後にロックを解放するため lane を占有せず（wall-clock 膨張の
解消）、完了は `reapCompletedDetachedRuns()` が後処理する（取り残しの解消）。

#### reaper による取り残し回収のセーフティネット

`runReaperTick()` は Linear を再スキャンして取り残し In-Progress Issue を実行キューへ再投入する。
従来この再スキャンは「実行中でない」かつ「アイドル（due なキュー項目なし）」または「cooldown 明け」時のみ
だったため、待機タスクが連続してキューが常にビジーだと再スキャンが starvation し、取り残しが回収
されなかった。現在は **最後の取り残しスキャンから `REAPER_STRANDED_MAX_INTERVAL_MS`（既定 5 分）が
経過していれば、ビジー時でも 1 回だけ再スキャンを許可**する（API レート制限付き）。実行中（lock 保持）/
cooldown 中は引き続き再スキャンしない。

### Discord 通知（lane / デタッチ状態の可視化）

デタッチ実行の状態は Discord に通知され、`DISCORD_WEBHOOK_URL_NOTIFY`（無ければ `DISCORD_WEBHOOK_URL`）
へ送られる（`src/lib/laneNotifier.ts`）。webhook 未設定時は no-op（後方互換）。

- 🚀 **Detached run launched** — issue / lane / pid（resume 再開時は `(resume)`）
- ✅ **Detached run 完了** — 成功（issue / lane / exit）
- ⚠️ **Detached run 完了（未検証）** — exit 0 だが完了未検証（成功クリーンアップ skip）
- ⏳ **Detached run usage-limit（resume 再投入）** — cooldown 後に resume 再投入
- ❌ **Detached run 失敗** — 失敗 exit

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
