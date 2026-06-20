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

---

# SOT-911 タスクの並列化 — PLAN（提案）

対象: ai-dev-control-plane（このリポジトリ）。種別: PLAN（提案のみ。実コード変更なし。In Review で停止）。
要望: 「タスクの並列化」「提案してください。」（受入条件なし）。
関連: SOT-792（runner レベルの並行実行基盤プラン、In Review）／[[sot792-parallel-exec-plan]]。

## 0. 結論（先出し）
「並列化」と言っても**層が複数**あり、層ごとに効果と制約が大きく異なる。最大の制約は
**Claude 利用上限が account-global**（[[runner-queued-but-stopped-diagnosis]]）であること。
このため「Claude run を同時に複数本」走らせても **スループットは増えず burn だけ倍増**する。
→ 効果が出る並列化は「**Claude を専有しない並列**（I/O待ち・デタッチ長時間処理・読み取り専用調査）」に絞られる。
推奨は **案①（issue 内 read-only 調査の sub-agent fan-out）＋ 案②（= SOT-792 案B のデタッチ実行）** の2本立て。
案③（複数 orchestrator 真並列）は上限制約により**非推奨**。

## 1. 「並列化」の対象レイヤ整理（どこを並列化するか）

| Lv | 並列化の対象 | 現状（直列の根拠 file:line） | 並列化の効果 | 制約 |
|----|--------------|------------------------------|--------------|------|
| L1 | issue 内の worker 工程（Claude→Gemini→Codex） | 工程は本質的に依存（実装→検証）。`run_gemini.sh`→`run_codex.sh` を順次実行 | ほぼ無し（検証は実装に依存） | 依存関係のため不可分 |
| L2 | issue 内の**独立サブ作業**（複数repo読取り・調査・live検証・git操作） | Claude が逐次ツール実行 | **中〜大**（I/O待ちを重ねられる） | Claude 1本内の話なので上限と無関係 |
| L3 | 複数 issue（同一/別repo）の同時処理 | 単一 `LOCK_FILE`(`src/runner.ts:92`)＋単一 `QUEUE_FILE`(`:93`)で直列。`acquireLock`中の他issueは `SKIPPED_LOCKED`(`webhook-server.ts:472`)→再enqueue | **小**（Claude 上限が account-global で頭打ち） | account-global 上限 |
| L4 | 長時間 sim / build をデタッチして本線を空ける | `runItem`(`src/runner.ts:1401`付近)が完了まで `await`、ロック保持＝run時間 | **大**（本線が他repoを処理可能に） | reaper/sentinel 設計が必要 |
| L5 | worker 成果物の分離（並行実行時の衝突回避） | `run_gemini.sh:7-8`/`run_codex.sh:7-8` が固定パス（report/prompt）| 並行の前提条件 | パスの lane 化が必要 |

## 2. 案の比較

| 観点 | 案①: issue内 read-only sub-agent fan-out（L2） | 案②: 長時間処理のデタッチ実行（L4＋L5、= SOT-792案Bハイブリッド） | 案③: 複数 orchestrator 真並列（L3） |
|---|---|---|---|
| 何を並列化 | 1 Claude run の中で、複数repo調査・複数受入条件チェック・複数live検証を `Agent` ツールで同時 fan-out | sim/長時間buildを別プロセス起動し即ロック解放、本線は別repoの細かいissueへ | scheduler/webhook を多重起動し別repo群を同時 drain |
| 効果 | 調査・検証フェーズの**実時間短縮**（I/O待ちの重ね合わせ） | 「sim中も他repoが止まらない」を達成（直列化の核心 H1/H2 を解消） | **throughput増えず**（account-global上限）。burnと衝突リスクのみ増 |
| 上限との整合 | ◎（Claude 1本内。新規runを増やさない） | ◎（orchestratorを増やさない。デタッチ側はClaude非専有） | ✗（前提と矛盾） |
| 既存基盤再利用 | ◎（`Agent`サブエージェントは既存。コード変更ほぼ不要・運用ルール追加のみ） | 高（usage-limit cooldown / Resume / queue / inflight をそのまま再利用） | 低（lock/queue/cooldown 全層の lane 化が必要で工事大） |
| 実装コスト | 小（運用ガイド＋プロンプト追記中心） | 中（SOT-792 §4 の子Issue 1→5） | 大（かつ効果なし） |
| 推奨 | **採用** | **採用** | **非推奨** |

## 3. 推奨案（2本立て）

### 案①（即着手可・低コスト）: issue 内 read-only 調査の並列 fan-out
- 適用場面: 複数repo横断の調査、複数受入条件の独立チェック、複数repoの live 検証、README整合 sweep 等。
- 方式: Claude が `Agent`（repo-scanner / acceptance-checker / Explore / general-purpose）を
  **読み取り専用タスクに限って同時 fan-out**。実装（書込み）は従来どおり Gemini 単線（衝突回避）。
- メリット: コード変更ほぼ不要。account-global 上限と無関係（1 run 内の I/O 並列）。
- 成果物: 運用ガイド（どのフェーズで fan-out 可/不可）を `prompts/claude/auto_run.md` 等に明文化。
- ガード: **書込み系（実装・git・PR）は並列化しない**（衝突・レース回避）。並列は read-only に限定。

### 案②（中コスト・SOT-792 と統合）: 長時間処理のデタッチ実行
- SOT-792 §3〜§4 の「案Bハイブリッド」をそのまま採用。`runItem` の long-run 判定 →
  デタッチ起動・即 `releaseLock()`(`runner.ts:1606` / `webhook-server.ts:485`) → sentinel/exit-code で
  完了検知 → 既存 Resume/enqueue 経路で後処理。worker 成果物は lane 別パス（L5）に分離。
- 子Issue分割は SOT-792 §4 の 1→5 を流用（重複Issueは作らず SOT-792 を実装フェーズに昇格）。

### 案③は不採用
- account-global 上限のため真の orchestrator 並列は throughput を増やさない。土台 lane 化の工事だけ
  発生し、衝突・burn リスクが増える。やるなら案②（デタッチ＝Claude 非専有の並列）に内包する。

## 4. 推奨ロードマップ
1. **案①を先行**（最小コスト・即効）: read-only fan-out の運用ルール明文化のみ。コード変更最小。
2. **案②を本命**: SOT-792（In Review）を実装フェーズに昇格し §4 の子Issue 1→5 を順次。
3. 案③は実施しない（上限制約で効果が出ないことを記録）。

## 5. 人間への確認事項（要選択）
1. 「並列化」の主目的はどれか？ (a) 1issue内の調査/検証を速くしたい（→案①） /
   (b) 長時間処理中も他repo開発を止めたくない（→案②=SOT-792） / (c) 複数issueを文字どおり同時実行（→案③、上限制約あり）。
2. 案②を進める場合、SOT-792 を実装フェーズに昇格してよいか（本Issue SOT-911 は提案で完結し、実装は SOT-792 配下で行う）。
3. デタッチ供給方式（tmux / nohup / 別コンテナ）の希望はあるか（無ければ実装Issueで選定）。

## 6. PLAN 終端
PR/merge せず Issue を In Review にして停止。人間が §5 を回答・案を選択したら、案①は運用ガイド追記の
小Issue、案②は SOT-792 §4 の子Issue分割で IMPLEMENT 系として着手する。

## 7. 追問への回答（2026-06-20）: 「親エージェントがタスク管理→subエージェントで処理」できるか

**結論: できる。ただし“どこまで効くか”は処理の種類で変わる。** これはまさに案①の発展形で、
本ハーネスでは既に親（Claude Code orchestrator）が `Agent` ツールで sub-agent を起動する仕組みがある
（利用可能な型: `repo-scanner` / `acceptance-checker` / `Explore` / `general-purpose` / `Plan` 等）。
親がタスクを分解・管理し、独立サブタスクを sub-agent に同時に投げる構成は今日から実現可能。

### 7-1. 効く / 効かない の境界（最重要）
sub-agent は**同一 Claude アカウントの予算を共有する**（usage 上限は account-global）。したがって:

| サブタスクの性質 | 並列 sub-agent の効果 | 理由 |
|---|---|---|
| I/O・待ち主体（複数repo調査、ファイル多数読取り、live検証、API待ち） | **大**（実時間短縮） | 待ち時間を重ねられる。総 burn は概ね同じ |
| Claude 計算主体（純粋に生成量が多い） | スループット増えない | N 並列＝上限に N 倍速で到達するだけ |
| 書込み（実装・git・PR） | 条件付き可 | 同一 repo/branch への同時書込みは衝突。**lane 分離が前提** |

つまり「親が管理・subが処理」は **読み取り/検証の並列**には即効果あり（＝案①）。
**書込みの並列**は「サブタスクが repo/ファイル単位で重ならない」場合のみ安全（案①の拡張、下記7-2）。

### 7-2. 推奨する具体構成（案①を“タスク管理＋sub処理”として明文化）
1. **親 = タスクマネージャ**: 親 Claude が issue を独立サブタスクへ分解し、依存関係と書込み競合の有無を判定。
2. **read-only サブタスク → 常に並列 fan-out**: 調査・受入条件チェック・複数repo live検証を sub-agent で同時実行。
3. **write サブタスク → lane が分離できる時だけ並列**:
   - 別 repo への変更同士は並列可（衝突しない）。
   - 同一 repo は単線（または file/branch lane を分けた時のみ並列）。worker 成果物パスの lane 化は §L5 が前提。
4. **長時間処理（sim/build）→ デタッチ**（案②＝SOT-792）。これは Claude を専有しないので上限と無関係に並列化できる。
5. **集約**: 親が各 sub-agent の結果を受け取り、最終判断・コミット・PR・Linear 同期を**単線で**行う。

### 7-3. 注意点
- 上限の壁は sub-agent でも消えない。「複数 issue を本当に同時に速く」したい動機なら、効くのは
  「Claude 非専有部分（待ち・デタッチ）」だけ、という §0 の結論は変わらない。
- 書込みの真の並列が欲しい＝複数 repo を同時に実装、は案③寄りで衝突・burn コスト大。基本は案②（デタッチ）に寄せる。
- まず低コストな **7-2 の read-only fan-out（案①）** を運用ルールとして明文化するのが最短。実装系の lane 化は
  SOT-792（案②）に統合する。

→ 回答として §5 の確認事項に「(d) 親管理＋sub処理を read-only fan-out として先行採用するか」を追加。
本Issue は PLAN のため In Review で停止。

## 8. 追問への回答（2026-06-20）: 「定期的に動くタスク（調査系）」と「稼働し続けるタスク」はどれが良いか

質問は並列化の“レイヤ”ではなく**タスクのライフサイクル（起動パターン）**の軸。ここでの最重要原則は
**「Claude（オーケストレータ）」と「実処理プロセス」を分けて考える**こと。account-global 上限があるため、
処理が長い／常駐するほど「Claude を保持し続けない」設計が効く。

### 8-1. 2類型 → 推奨実行モデル

| 類型 | 例 | 推奨実行モデル | Claude の関与 | 該当案 |
|---|---|---|---|---|
| **A. 定期起動タスク**（間欠・短命） | 調査/リサーチ、受入チェック、定点 live 検証、価格・在庫の定期取得 | **スケジュール起動の都度 short-run**（cron / webhook トリガ）。1 tick = 1 短命 run。常駐させない | tick の間だけ。終わったら解放 | 案①（run 内 read-only fan-out） |
| **B. 常駐／長時間タスク**（連続） | sim/build、監視ループ、ストリーム処理、長時間スクレイプ | **デタッチ実行**：非Claudeプロセスで走らせ、Claude は起動と完了検知だけ。sentinel / exit-code で再開 | 起動時と完了イベント時のみ | 案②＝SOT-792 案B |

### 8-2. なぜこの割り当てか
- **A（定期・調査系）は「保持」より「再起動」が正解。** 調査は待ち主体で短命。Claude を常駐させると上限を
  浪費するだけ。**cron/webhook で都度起動 → run 内で read-only sub-agent fan-out（案①）→ 終了**が最小コストで最速。
  複数の調査対象は 1 run 内で並列 fan-out すれば実時間短縮（総 burn は同等）。tick 同士は時刻をずらせば上限衝突も回避。
- **B（常駐・長時間）は「Claude で回し続けない」のが正解。** 連続稼働を Claude run で抱えると、何もせず待つ間も
  account-global 予算を専有し本線が止まる。**実処理は非Claudeプロセス（script/別コンテナ）に出し、Claude は
  起動→ロック即解放→sentinel/exit-code で完了検知**（＝SOT-792 の核心）。Claude を専有しないので上限と無関係に
  他 repo を並行処理できる。

### 8-3. ハーネス上の対応プリミティブ（既存）
- **A 用**: `CronCreate`/`CronList`（スケジュール）、`ScheduleWakeup`（自己ペースの再起動）、webhook 単発起動。
  run 内の並列は `Agent`（sub-agent fan-out, read-only）。
- **B 用**: `Bash run_in_background` / `Agent run_in_background`（デタッチ起動）、`Monitor`（安価なポーリング/完了検知）、
  sentinel ファイル＋exit-code。直列化の核心（単一 `LOCK_FILE`＝`src/runner.ts:92`、`runItem` の完了 await）を
  最小変更で解く点は SOT-792 §4 に既出。

### 8-4. 結論（どちらが良いか）
- 「調査のように**定期的に動く**」→ **A：cron/webhook の都度 short-run ＋ run 内 read-only fan-out（案①）。常駐させない。**
- 「**稼働し続ける**」→ **B：デタッチ実行（案②＝SOT-792）。実処理は非Claude、Claude はイベント時のみ。**
- 両者は排他でなく**組み合わせ可能**：定期起動された run が、内部で長時間処理を起動してデタッチし即終了する（A が B を仕込む）構成が、上限制約下で最もスループットが出る。

→ §5 の確認事項に「(e) 定期タスク=cron都度起動／常駐タスク=デタッチ、の役割分担を運用方針として採用してよいか」を追加。
本Issue は PLAN のため In Review で停止（PR/merge/Done には進めない）。

## 9. 最善案（単一推奨, 2026-06-20）: 「あなたの考える最善案を提案してください」への回答

これまでは案①/②/③ と確認事項の“選択肢提示”だったが、人間が「最善案を1つ」を要望。
以下を **単一の推奨構成** として提示する。

### 9-1. 結論（1行）
**「定期 webhook/cron の都度 short-run」を土台に、run 内で read-only サブタスクのみ並列 fan-out（案①）し、
長時間・常駐処理だけをデタッチ（案②＝SOT-792）。書き込み（実装/git/PR）と Claude 計算は単線のまま。**
複数 orchestrator 真並列（案③）は account-global 上限で増えないので採らない。

### 9-2. なぜこれが最善か（決め手）
- **唯一の硬い制約は account-global の Claude 利用上限。** よって「Claude を専有しない並列」だけが実時間を縮める。
  案①（待ち主体の read-only）と案②（非Claudeプロセスにデタッチ）はどちらも非専有 → 効く。案③は専有のまま本数だけ
  増やすので burn が倍増しスループットは増えない → 不採用で確定。
- **低コスト即効と本命を組み合わせる。** 案①は運用ルールの明文化のみでコード変更ほぼ不要（今日から）。案②は本命だが
  実装を伴う → 既存 SOT-792 を実装フェーズに昇格して流用（重複Issueを作らない）。この2段構成が「最小着手で最大効果」。

### 9-3. 推奨する実行モデル（タスク種別ごと, 1枚に集約）
| タスク種別 | 採る方式 | 並列するもの | 並列しないもの |
|---|---|---|---|
| 調査・受入チェック・複数repo live検証（読取り/待ち主体） | **案①**: 1 run 内で `Agent` read-only fan-out | 調査の枝（実時間短縮） | 集約後の commit/PR は単線 |
| 実装・git・PR（書き込み） | 単線。**lane が別repoの時だけ**並列可 | 別repo同士のみ | 同一repo/branch は必ず直列 |
| sim/build・監視ループ・長時間スクレイプ（常駐/長時間） | **案②=SOT-792**: 非Claudeにデタッチ、Claudeは起動と完了検知のみ | 本線の他repo処理（Claude非専有） | — |
| 純粋に生成量が多い（Claude計算主体） | 単線で受容 | （並列しても上限にN倍速で当たるだけ） | — |

### 9-4. 最短ロードマップ（推奨実施順）
1. **案①を運用ルール化（即）** — 「read-only調査/検証は sub-agent fan-out、書き込みは単線、別repoのみlane並列可」を
   ハーネス運用方針として明文化。コード変更ほぼ無し。
2. **案②を実装着手（本命）** — SOT-792 を実装フェーズに昇格し、§4 の子Issue 1→5（long-run判定→デタッチ→ロック即解放→
   sentinel/exit-code 完了検知→Resume/queue 後処理、worker成果物の lane別パス分離）を実施。
3. **案③は実施しない** — account-global 上限のため throughput 増なし。

### 9-5. 人間に必要な決定（最善案を進めるための最小確認, 1つだけ）
- **Q: 上記「案①即運用ルール化 ＋ 案②=SOT-792 を実装昇格」をそのまま進めてよいか？**
  - Yes → 本Issue(SOT-911)は提案完了で Done 相当、実装は SOT-792 配下で開始。
  - デタッチ供給方式（tmux / nohup / 別コンテナ）の希望があれば SOT-792 側で指定。

本Issue は PLAN のため In Review で停止（PR/merge/Done には進めない）。実装は承認後 SOT-792 で行う。

---

## SOT-931 follow-up: 待ち時間（直列待ち）解消の方式提案（account-global 上限を制約にしない前提）

### 前提の更新（人間コメント 2026-06-20T16:03Z）
> account-global 上限は問題ない。待ち時間解消を解決する方法を提案してください。

これまで「直列・単線が妥当」としていた根拠は **account-global の Claude 上限が律速だから N 並列にしても
上限を N 倍速で食うだけ**、という点だった。人間がこの前提を外したので、**待ち時間（queue 直列待ち）そのもの**
を構造的に潰す提案に切り替える。

### 今の待ち時間の発生源（コード根拠）
- `src/webhook-server.ts`: 1 run ごとに JS `acquireLock` ＋ `run_auto.sh` の OS flock を取得 →
  `drainQueue()` が残りを **単一 lane で直列処理**。次の Issue は前の run が lock を返すまで queue で待つ。
- 並行は `RUNNER_LANE`（SOT-911 案②）による **別 repo の時だけ**。**同一 repo / 同一 branch は git 破損防止
  のため必ず直列** → 同一 repo の Issue は単線の前景 lane が空くまで待つ（直近5タスクが完全直列だった理由）。
- `long-run` ラベル時のみデタッチ＋即 lock 解放。それ以外は前景で run 全体 lane を占有。

### 提案（3案、推奨は案A）

#### 案A（推奨）: 並行ワーカープール（max-parallel N）＋ worktree レーン＋既定デタッチ
- 単一 JS lock を **N スロットのセマフォ**に置換。queue 供給役（drain supervisor）が空きスロットに
  キュー先頭を割り当てる。**空きスロットがある限り待ち時間 ≈ 0**。
- 各スロットは **専用 git worktree（自動採番 branch/lane）** で動く。これにより
  「同一 repo / 別 branch」を別クローン無しで安全に並行でき、現行の「同一 repo は直列」制約を
  **「同一 branch だけ直列／別 branch は並行可」へ緩和**できる（待ち時間の主因を直接除去）。
- **既定デタッチ化**: webhook は enqueue して即 return、supervisor が空きスロットへ流す。
  `long-run` だけでなく通常 run も切り離す。完了は既存の done-marker＋`reapCompletedDetachedRuns`
  ＋inflight＋`laneNotifier` をそのまま再利用（作り直さない）。
- 安全弁: **同一 branch は必ず直列**（worktree 単位の per-branch ロックを維持）。N は env（例
  `RUNNER_MAX_PARALLEL`、既定1＝現行互換）で段階導入。
- 効果: 同一 repo を含むキューが N まで並走 → 直近5タスクのような直列待ちが解消。account-global 上限を
  気にしない前提なので、N を上げるほど wall-clock 短縮（Claude 推論フェーズも実並走）。
- コスト/リスク: account-global 上限を実際に N 倍速で消費する（人間が許容と明言）。worktree 採番・後始末、
  branch 衝突回避、ログ/通知の lane 別集約の実装が必要（既存 lane 基盤の小規模拡張で実現可能）。

#### 案B（中規模）: 既定デタッチ化のみ（プールは入れず lane を per-issue 自動採番）
- 通常 run も `long-run` と同じく切り離して即 lock 解放。`RUNNER_LANE` を per-issue 自動採番にして
  別 repo/別 branch を並行ドレイン。worktree は入れず、別 repo は既存の別クローンを使う。
- 効果: 別 repo・別 branch の待ちは消えるが、**同一 repo / 同一 branch の直列は残る**（worktree が無いため）。
- 案A より小さく入るが、直近5タスク（全部同一 repo）の直列はほぼ解消しない。

#### 案C（最小）: 並列はせず待ち時間の「無駄分」だけ除去
- SOT-930 の 7 回再実行のような **reaper 再エンキュー由来の無駄な待ち**を止める（待機/長時間は
  `long-run` デタッチ＋確実な終端化＝SOT-925 の運用徹底）。cooldown の誤検知（過去の false-cooldown）も
  実 usage-limit のみに限定。
- 効果: 構造的な直列は残るが、**重複・空転による待ち増分**は消える。並列の前段として無コストで効く。

### 比較まとめ
| 案 | 同一repo待ち解消 | 実装規模 | account-global 消費 | 既存基盤再利用 |
|----|------------------|----------|---------------------|----------------|
| A（推奨）| ○（別branch並走）| 中〜大 | N 倍（許容前提）| done-marker/inflight/reaper/laneNotifier |
| B | △（別repo/別branchのみ）| 中 | 並走分だけ増 | lane基盤 |
| C | ×（無駄分のみ）| 小 | 変化なし | SOT-925 運用 |

### 推奨
**案A**。account-global 上限を制約にしない前提なら、待ち時間の主因（同一 repo 直列）を worktree レーン＋
並行プールで直接除去できる。導入は `RUNNER_MAX_PARALLEL=1`（現行互換）から段階的に N を上げる。
案C（reaper 無駄取り）は案A/Bと併用で先に入れてよい（低リスク）。

本Issue は PLAN のため In Review で停止（PR/merge/Done に進めない）。実装は人間が案を選択後、別 IMPLEMENT
Issue（案A なら worktree プールを SOT-911 案② lane 基盤の拡張として）で行う。

---

# SOT-935 — 脆弱性見直し & リファクタリング計画

種別: SECURITY + リファクタリング（「plan してそのまま実装に移る」指示）
対象: ai-dev-control-plane 本体

## 背景
継ぎ接ぎ実装による脆弱性の見直しとリファクタリング要望。本体コードを実測調査した結果、
コードは概ねセキュリティを意識して書かれている（例: `triggerRunDetached` は issueId/パスを
shell 引数でなく env 経由で渡す旨を明記）。ただし以下の**具体的かつ低リスク**な脆弱性 1 件と、
大きな「継ぎ接ぎ」リファクタ候補を特定した。

## 実測した脆弱性 / コードスメル
1. **[SECURITY/本Issueで実装] HMAC 署名比較が非定数時間**
   - `src/webhook-server.ts:316` `verifyLinearSignature` が `signature === expected` で
     HMAC を比較している。タイミングサイドチャネルで署名を推測されうる典型脆弱性。
   - 修正: `crypto.timingSafeEqual` による定数時間比較に変更（長さ不一致・非文字列ヘッダを
     安全に false 化）。Discord 側（`verifyDiscordSignature`）は ed25519 で既に安全。
2. **[REFACTOR/フォローアップ] `src/runner.ts` が 2738 行の god-file**
   - lock/queue/lane/detach/reaper/cooldown/notify/git 状態取得などが 1 ファイルに同居。
     最大の「継ぎ接ぎ」要因。テスト（runner.test.ts 2237 行）が手厚いので段階的抽出は可能だが、
     **稼働中の control-plane 自身**を書き換えるため一括リライトは高リスク。
   - 推奨: lock/queue・detach/reaper・cooldown 等の責務単位で **小さな PR に分割**して抽出する
     （各 PR でテスト緑を維持）。autonomous で無監督に一括実行はしない。
3. **[REFACTOR/フォローアップ] `src/lib/discordCommandHandlers.ts`(643) / `src/webhook-server.ts`(628)**
     も大きめ。ハンドラ単位の抽出余地あり。

## 本Issueのスコープ（実装する分）
- 上記 **#1 の HMAC 定数時間比較化**（脆弱性の即時修正）＋ガード用ユニットテスト追加。
- これは低リスク・テスト可能で「脆弱性を見直し」の中核に直接応える。

## フォローアップ（人間の優先度判断待ち）
- #2/#3 の god-file 分割は別 IMPLEMENT Issue として、責務単位の小 PR で段階実施することを推奨。
  稼働中ランナーへの回帰リスクを避けるため一括自動リライトは避ける。
