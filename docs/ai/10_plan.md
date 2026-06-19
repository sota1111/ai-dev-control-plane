# SOT-792 設計メモ — 長時間sim repoと細かい変更repoの並行開発実行基盤

種別: PLAN（設計のみ。実コード変更なし。In Review で人間のレビュー/選択待ち）
関連: SOT-810（ai-dev-control-plane の機能改善提案）

## 目的
1つの control plane で「時間のかかるシミュレーションを行うレポジトリ」と「細かい変更が
多数あるレポジトリ」を**並行して**開発できるようにする。特に sim 実行中でも別レポジトリ
の開発（drain）が止まらない実行モデルを設計する。

---

## 1. 現状アーキの実測サマリ（直列化の根拠）

仮説 H1–H3 を実コードで検証。すべて **CONFIRMED**（file:line は現行 main 時点）。

### H1: 単一ロック＋単一キューで実行が直列化している — CONFIRMED
- `src/runner.ts:86-87` — `LOCK_FILE = runner.lock` / `QUEUE_FILE = runner.queue.json` は
  `LOG_DIR` に結合された**モジュール定数**で単一。lane/repo 別の分離手段が存在しない。
- `acquireLock()`(`src/runner.ts:124-152`) / `releaseLock()`(`:165`) は単一 `LOCK_FILE`
  を排他制御する。
- drain 経路: `drainQueue()`(`src/runner.ts:1523`) が `acquireLock()`(`:1575`) →
  `await runItem(item)`(`:1599`) → `finally { ... releaseLock() }`(`:1606`)。
  ロックは `runItem` 完了まで保持される。
- webhook 経路: `src/webhook-server.ts:467` で `acquireLock` → `:481` `await runner.runItem(item)`
  → `:483` `finally { runner.releaseLock() }`。同一パターン。
- `runItem()`(`src/runner.ts:1401`) は `:1419` で `await triggerRun(issueId, …)` を
  **完了まで await** する（triggerRun = Claude run 本体）。
- ⇒ **ロック保持時間 = runItem 実行時間 = run（sim）の所要時間**。sim 実行中は他 repo の
  issue が drain/webhook いずれの経路でも `SKIPPED_LOCKED` → 再enqueue され、sim 完了まで
  全待ちになる。これが直列化の核心。

### H2: WORKER_TIMEOUT で長時間 sim が kill される — CONFIRMED
- `scripts/ai/run_gemini.sh:18` / `scripts/ai/run_codex.sh:18` — `WORKER_TIMEOUT=${...:-1800}`（既定30分）。
- 実行は `timeout "${WORKER_TIMEOUT}s" …`（`run_gemini.sh:36/41`, `run_codex.sh:45`）。
- ⇒ 同期実行のままでは sim worker は30分で SIGTERM kill される。長時間 sim を直接ワーカー
  として走らせる方式は破綻。

### H3: ワーカー成果物/プロンプトの共有衝突 — CONFIRMED
- `run_gemini.sh:7-8` — `PROMPT_FILE=prompts/gemini/implement.md` /
  `REPORT_FILE=docs/ai/50_worker_gemini_report.md`（固定パス）。
- `run_codex.sh:7-8` — `prompts/codex/debug.md` / `docs/ai/60_worker_codex_report.md`（固定パス）。
- ⇒ 2 つの run が並行すると同一プロンプト/レポートファイルを相互上書きし、報告が壊れる。

---

## 2. 複数案の比較

| 観点 | 案A: repo/lane 単位でロック・キュー・成果物を分割し並行 drain | 案B: 長時間 sim をデタッチ起動し Claude は即ロック解放→別 Issue、完了を sentinel/exit-code で検知し既存 Resume/キューで再投入 | 案C: scheduler 多重起動＋env でロック/キュー/Linear フィルタ分離（暫定） |
|---|---|---|---|
| メリット | 概念が素直。lane ごとに真の並行 | 核心(H1/H2)を最小変更で解消。orchestrator を増やさない | 既存バイナリのまま env だけで暫定分離を狙える |
| デメリット | 複数 orchestrator 並走を狙うと **Claude 上限が account-global**（[[runner-queued-but-stopped-diagnosis]]）のため cooldown 中スループットは増えず burn だけ倍増。lock/queue/cooldown 全層の lane 化が必要で工事大 | デタッチプロセスの reaper が必要（既知の leaked inflight と同根）。完了検知の sentinel 設計が要る | `LOCK_FILE`/`QUEUE_FILE` が**ハードコード定数**(`runner.ts:86-87`)で env 非対応。env だけでは分離不可＝結局土台工事が必須で「暫定」にならない |
| 既存基盤の再利用度 | 中（drain/queue は使えるが cooldown/Resume の lane 化が追加要） | **高**（usage-limit cooldown / Resume / queue 再投入 / inflight をほぼそのまま再利用） | 低〜中（土台改修前提なら案Aに合流） |
| 実装コスト | 大 | 中 | 見かけ小・実態大（不採用） |

補足:
- 真の「複数 orchestrator 並列」は account-global 上限のため throughput を増やさない。
  よって「sim を 1 本デタッチして本線 orchestrator を空ける」案Bが上限制約と整合的。
- 案C は土台が env 非対応のため単独では成立しない。土台工事をするなら案A/Bに含める。

---

## 3. 推奨案

**案B を主軸**（long-run/sim issue をデタッチ起動し、Claude は即ロック解放して別 repo の
細かい issue を処理）。**＋ lane 別ワーカー成果物パス（案Aの最小スライス）をハイブリッド**で
取り込み H3 を解消する。

理由:
- H1/H2（直列化と timeout kill）を**最小変更・最大再利用**で解消できる。
- orchestrator を増やさないため account-global 上限と矛盾しない。
- usage-limit cooldown / Resume / queue 再投入 / inflight の既存基盤をそのまま活かせる。

### 「sim 中も他 repo が止まらない」保証ポイント（コード）
long-run と判定した issue の `runItem`(`src/runner.ts:1401`) を **`await` しないデタッチ起動**
に変える:
1. sim を別プロセス（tmux/nohup/別コンテナ。方式は実装Issueで選定）で起動し、sentinel ファイル
   と inflight 記録を残して**すぐ return**。
2. drain 側 `finally` の `releaseLock()`(`runner.ts:1606`) / webhook 側 `releaseLock()`(`webhook-server.ts:483`)
   が即実行され、orchestrator は次の queue item（別 repo の細かい issue）を通常処理。
3. sim 完了は sentinel/exit-code で検知し、既存 **Resume/queue 経路**(`runItem` の
   `isResume`/`reason==='usage_limit'` 系, `enqueue`)で結果を再投入して後処理。
4. global cooldown は**新規 launch のみ** gate（デタッチ済み sim は対象外）。

これにより「ロック保持時間 = sim 時間」が「ロック保持時間 ≒ デタッチ起動時間（数秒）」に
変わり、直列化が解消される。

---

## 4. 影響を受けるファイルと段階的移行手順（＝実装する場合の子Issue分割案）

各 Issue は機能/コミット単位（実装＋検証＋doc を内包）。依存順:

1. **runner のパスを lane 対応にする**
   - 対象: `src/runner.ts`(`:86-87` LOCK/QUEUE 定数), `src/lib/schedulerCore.js`
   - 既定 lane=現行互換（後方互換を維持）。
2. **long-run issue のデタッチ実行モードを追加する**
   - 対象: `src/runner.ts`(`runItem`/`drainQueue`), `src/webhook-server.ts`
   - long-run 判定 → 即ロック解放・sentinel/inflight 記録。
3. **sim 完了検知と結果再投入を実装する**
   - 対象: `src/runner.ts`（Resume 経路再利用）, `docs/usage-limit-and-resume.md`
   - sentinel/exit-code 監視 → 既存 enqueue/Resume で後処理。
4. **ワーカー成果物の lane 別パス＋per-lane WORKER_TIMEOUT**（H2/H3 解消）
   - 対象: `scripts/ai/run_gemini.sh`(`:7-8/:18`), `scripts/ai/run_codex.sh`(`:7-8/:18`),
     `prompts/gemini/implement.md`, `prompts/codex/debug.md`
5. **可視化とドキュメント更新**
   - 対象: Discord 通知, `docs/runner-queue.md`, `prompts/claude/auto_run.md`

最小実用 = 1→2→3。H3 完全対策に 4。運用性に 5。

---

## 5. 破綻ケース検討

- **デッドロック**: ロックは単一かつデタッチ後即解放のため相互待ちは生じない。
- **キュー飢餓**: drain は `dequeue` 順（Linear priority 準拠, [[runner-queued-but-stopped-diagnosis]]）。
  sim をデタッチで外すことで細かい issue の飢餓はむしろ解消。
- **成果物ファイル衝突**: lane 別パス（手順4）で解消。手順4 完了前は long-run を 1 本に限定して回避。
- **同時実行上限**: account-global 上限のため「同時に複数 Claude run」はしない。並行するのは
  「デタッチ済み sim（Claude を専有しない）」＋「本線 orchestrator 1 本」の構成。

---

## 6. リスクと未解決の論点

- account-global 上限のため「真の並列 orchestrator」は throughput を増やさない（推奨案の前提）。
- デタッチプロセスの **reaper が必須**（leaked inflight の既知課題 [[runner-queued-but-stopped-diagnosis]] と同根）。
- デタッチ供給方式（tmux / nohup / 別コンテナ）は実装Issueで選定。
- sim の cooldown（sim 自身が usage-limit に当たった場合）の扱いは手順3で詰める。

---

## 7. 受け入れ条件の充足

- [x] 「sim 中も他 repo が止まらない」保証をコード上の具体ポイントで説明（§3）。
- [x] 仮説 H1–H3 を file:line でコード根拠付き検証（§1）。
- [x] 複数案を比較し推奨案＋段階的移行手順を提示（§2–§4）。
- [x] PR/merge せず Issue を In Review で停止（PLAN 終端状態）。

次アクション: 人間が推奨案（案Bハイブリッド）を承認したら、§4 の子Issue分割 1→5 で
IMPLEMENT 系として着手する。

---

# SOT-833 監視対象の範囲指定 — PLAN

対象リポジトリ: booking-monitor (`/workspaces/booking-monitor`, Python/FastAPI)
分類: PLAN（設計）。要望が簡潔・受入条件なし・実サイト調査が必須のため、実装前に方針を人間確認。

## 1. ゴール（要望）
- 時刻・日付の「範囲」を指定して監視したい。
- その範囲内で「いつ空いていて／いつ空いていないか」が分かるように表示する。

## 2. 現状とギャップ（file:line 根拠）
- `booking_monitor/config.py` `Conditions`: 単一 `time: str` ＋ `days_of_week: List[str]`。
  → 時刻範囲・日付範囲は未対応。
- `booking_monitor/checker.py` / `services/monitor_service.py`: 各ターゲットを
  単一 `(available: bool, summary: str)` に集約。スロット別の構造化結果なし。
- `booking_monitor/sites/tablecheck.py::_find_available_weekend_slots`: 空きラベルを
  最大3件 summary 文字列に詰めるのみ（日時と紐づかない、ロッシー）。
- `templates/status.html` + `services/view_models.py::build_status_view`: ターゲット
  1行＝1ステータスバッジ。`time`/`days_of_week` を文字列表示するだけで、スロット別
  の空き/満席グリッドはない。

## 3. 設計案

### 3-1. 条件スキーマ（config）
- 案A（推奨）: `Conditions` を拡張。
  - `date_range: {start: "YYYY-MM-DD", end: "YYYY-MM-DD"}`
  - `time_range: {start: "HH:MM", end: "HH:MM", step_minutes: int}`
  - 旧 `time` / `days_of_week` は残しフォールバック（後方互換）。
- 案B: 汎用 `slots: [ "YYYY-MM-DD HH:MM", ... ]` を明示列挙（柔軟だが冗長・運用負荷大）。
- 推奨理由: 案A は範囲＋刻みで簡潔に表現でき、既存 config.json を壊さない。

### 3-2. 結果モデル / 保存
- checker の戻り値を `(available: bool, summary: str, slots: List[Slot])` に拡張。
  `Slot = {datetime: ISO, available: bool, source: "dom"|"keyword"}`。
- `store_check_history` にスロット別 JSON を保存し、`view_models` で集計。
- 後方互換: `slots` 空なら従来の単一ステータス表示にフォールバック。

### 3-3. 表示
- 案1（推奨）: ターゲット詳細に「日付 × 時刻」グリッド/ヒートマップ
  （緑=空き、灰=満席、白=範囲外/未取得）。要望「いつ空いて／いつ空いてないか」に直結。
- 案2: 空きスロットのリスト表示のみ（実装軽いが「空いてない」可視化が弱い）。

## 4. 最大リスク（実サイトスクレイピング）
- tablecheck の実カレンダー DOM から、指定範囲分のスロット別空き状況を確実に取得できるか
  は未検証。現行は3ラベルのみ。範囲分取得にはカレンダー月送り遷移 or 内部 API 解析が必要で、
  実サイト調査が前提。本環境では Codex/Playwright がクールダウン中で live 検証不可のため、
  ブラインド実装は Quality Gate（E2E/受入）を満たせない。
- `generic` サイトはキーワード判定のみで、スロット別取得は原理的に不可
  （範囲機能は tablecheck 等カレンダー型サイト限定になる想定）。

## 5. 人間への確認事項（要選択）
1. 「範囲」は時刻範囲・日付範囲の両方か？刻み（30分等）は？
2. 表示は案1グリッド（ヒートマップ）か、案2空きリストか？
3. 対象は tablecheck のみで良いか（generic は範囲スロット非対応）？
4. 通知条件は「範囲内のいずれか空き」で良いか、特定スロットのみか？

## 6. 実装フェーズに進む場合の子Issue分割案（承認後）
- ① 条件モデルに `date_range`/`time_range` 追加＋後方互換（config.py, config.json, tests）
- ② tablecheck で範囲分のスロット別空き状況を取得（sites/tablecheck.py, 実サイト調査必須）
- ③ スロット別結果の保存＋view_model 集計（history, view_models, monitor_service）
- ④ ダッシュボードにスロットグリッド表示（status.html）
- 依存順: ①→②→③→④（②が最大リスク・要実サイト調査）。

## 7. PLAN 終端
PR/merge せず Issue を In Review にして停止。人間が §5 を回答・§3 の案を選択したら、
§6 の子Issue分割で IMPLEMENT 系として着手する。
