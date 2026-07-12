# SOT-1531 — ベンチマーク実施後の分析

最新コメント(2026-07-05)の後段2要求「①システムの改善点洗い出し ②評価方法の見直し」に対応。
本パイプライン run(SOT-1531 を各 role で処理)と既存ハーネスコードの観測に基づく。

## 1. システムの改善点(洗い出し)

| # | 観測された課題 | 改善案 |
|---|----------------|--------|
| S1 | **メタタスクを標準パイプラインで実行できない**。`implementation` role は制約付きワーカーで、他ワーカー(codex/antigravity)を実ディスパッチできない(`AI does not call AI`)。「ベンチマーク実行」は本質的に worker ディスパッチを伴うため、implementation では live 比較を完遂できない。 | **✅実装済(本run)**: 比較専用ランナー `scripts/ai/run_benchmark.sh` を追加。固定タスクを1 role で回し worker だけ入替→ M4(時間)/M5(中断=handoff/exhausted 数)/M6(diff numstat)を metrics JSON に自動採取。`RUN_WORKER_DISPATCH=1`(＝ディスパッチ済ワーカー内)では自身を拒否し、オーケストレータ/人間シェルからのみ実行可(AI does not call AI を強制)。残りの M2/M8 は手採点で `scoreBenchmarkRun()` に渡す。 |
| S2 | **メトリクスが自動採取されない**。M3(デバッグ数)/M4(時間)/M5(中断)は `docs/ai/auto_logs/` に散在し手転記が必要 → 誤差・工数。 | `run_auto.sh` が run 毎に構造化 metrics(`docs/ai/auto_logs/metrics/<issue>.json`: role別 wall-clock・handoff数・debugサイクル・git diff --stat)を出力。`benchmarkScore.ts` がそれを読んで自動採点。 |
| S3 | **前 run の計画ファイルが混入**。今回 `10_plan.md`/`30_tasks.md`/`40_acceptance.md` に別Issue(SOT-1526)の内容が残存していた。 | これらを **issue 単位に名前空間化**(`docs/ai/pipeline/<issue>/…`)し、run 開始時に初期化。取り違え・誤採点を防ぐ。 |
| S4 | **worker 可用性が比較を歪める**。memo に codex/antigravity の chronic auth(exit75)。2/3 が常時フォールバックすると 3-worker 比較が成立しない。 | 比較 run 前に **worker health プリフライト**(`scripts/ai/worker_health*`)を必須化し、不可用ワーカーは結果表に `unavailable` を明示(M5 に計上)。 |
| S5 | **role 間でレポートファイルを上書き**。1 パイプライン内で task-check→decomposition→implementation が同じ `55_worker_claude_report.md` を再利用し履歴が消える。 | role 別レポート名(`docs/ai/reports/<role>.md`)か、role 見出し付き追記に変更。監査性向上。 |

## 2. 評価方法の見直し

| # | 現行の弱点 | 見直し案 |
|---|-----------|----------|
| E1 | **M4 時間の正規化が固定 30 分**。DOC と IMPLEMENT で所要が桁違いなのに同一 ceiling は不公平。 | タスク種別ごとの ceiling、または **ベースライン C0 比の相対値**で正規化。`scoreBenchmarkRun(maxDurationMs)` は既に引数化済 → task 別に渡す。 |
| E2 | **M1 ゲートが all-or-nothing**。lint 通過・test 失敗のような部分成功の信号が消える。 | ゲートを **項目別内訳**(lint/typecheck/test/e2e 各 0/1)で保持し、重み付き部分点に。 |
| E3 | **合成スコアの重みが当て推量**。 | パイロット 2〜3 run で **感度分析**(重みを振ってランキングが安定か)。重みは `ScoreWeights` で明示引数化済 → 分析を機械的に回せる。 |
| E4 | **decomposition ルーブリックが「不要」判断に噛み合わない**。B1(不要)では R2–R4(子Issue 粒度/独立性/検証可能性)が非該当で、満点扱いにするとスコアが不当に高く見える。 | **✅実装済(本run)**: `scoreDecompositionRubric` に `verdict` 別分岐を追加。「要」→ R1–R7 全適用、「不要」→ R1(妥当性)+R6(親コメント/状態同期)+R7(restraint)のみを採点し3軸平均を 7..35 へ正規化(非該当軸は満点扱いしない)。`appliedAxes` で適用軸を明示。テスト2件追加(`benchmarkScore.test.ts`)。B1 を verdict-aware で再採点(`SOT-1531-results.md`)。 |
| E5 | **単一 run のノイズ**。1 回では worker のばらつきを評価できない。 | 主要セルは **≥2 反復**し平均＋分散を併記。分散が大きい role は「worker 依存性が高い」と判断。 |
| E6 | **要否の一致を品質採点より優先**する構造が明示的でない。 | 既に `necessityMatchedReference=false` で `NECESSITY_MISMATCH_PENALTY` を効かせている。これを**ゲート(不一致は品質点に関わらず下位固定)**として運用ルール化。 |

## 2.5 実測ベンチマーク結論(observational コーパス C、`SOT-1531-results.md` §C)

`docs/ai/auto_logs/auto_runner.log`(2026-07-01〜07-05 03:52、約4日、**agy 再認証後に再集計**)の実 run を集計した観測ベンチマーク:

- **完遂(win)数**: claude 139 / codex 8(task-check6・verification2) / **antigravity 0**(母数 DONE 147)。
- **handoff(非応答)**: antigravity 4(全て `ANTIGRAVITY_AUTH_UNHEALTHY` chronic auth、最終 07-04 16:15) / claude 3(usage-limit)。
- **agy 強制 primary の実 leg を取得(§C.5・決定的・SOT-1533)**: §C.4 の「強制 primary が必須」手順を
  子 Issue **SOT-1533**(`workers: implementation=antigravity>codex`)で実行し、**過去 run で取れなかった
  agy 一次 implementation leg を初めて実測**した。結果=**04:16:42 agy 実ディスパッチ→04:17:22 `Error:
  authentication failed or timed out`→CHRONIC auth failure(exit75, auth-unhealthy を epoch 1783225942=
  04:32:22 UTC に再マーク)→handoff→codex が ~132s で完遂(PR#6)**。
  → **従来仮説の反証**: 「agy=0 は未到達だから(auth 復旧済)」は誤り。**到達させても再認証後に同一 chronic
  auth で即失敗し完遂不能**。起動ゲートが clear に見えても実ディスパッチ時に CLI 認証が失敗する状態が継続。
- **実データ結論**(交絡=chain順・タスク非統制を明示した上で):
  1. **antigravity は「auth 復旧済・未実測」ではなく、実測で「再認証後も実ディスパッチ時 chronic auth
     exit75=完遂不能」**(最小の T4-doc DOC でも 0)。fallback は codex が堅牢に補完(~132s 完遂)。
  2. **codex は task-check / verification を 8/8 完遂・中断0、かつ implementation の fallback も堅牢**(T4-doc を
     ~132s 完遂)→ 検証系の一次候補として有力。
  3. claude は全 role を高信頼で完遂するが **usage-limit がアカウント横断の単一障害点**。

### role→worker 推奨(暫定・観測ベース、controlled A run 確定前の proposal)

| role | 現行 chain | 観測に基づく暫定提案 | 根拠 |
|------|-----------|----------------------|------|
| task-check | claude,codex,antigravity | **codex,claude**(codex 一次) | codex が 6件完遂、軽量判定で claude の usage-limit を温存 |
| verification | claude,codex,antigravity | **codex,claude** | codex が 2件完遂・中断0、検証は codex 適性 |
| implementation | antigravity,codex,claude | **codex,claude**(antigravity は末尾/無効化検討) | §C.5 実測: agy 強制 primary でも T4-doc を完遂できず exit75。codex fallback が ~132s で完遂(PR#6) |
| その他4 role | claude,… | claude 一次を維持(antigravity は末尾) | claude が高信頼完遂 |

> ⚠これは observational + 1件の controlled implementation leg(§C.5)に基づく proposal。速度(M4)・差分品質(M6)の
> 網羅的な worker 間優劣は A1(claude)/A2 追試を揃えた後に確定(A2=codex は §C.5 で実測済)。
> antigravity は **実測の結果 再認証後も実ディスパッチ時 chronic auth で完遂不能**(§C.5)。当面は chain 末尾
> 維持で fallback により実害なし。無駄な ~40s の失敗待ち・誤解を招く marker 再付与を避けるなら
> `ANTIGRAVITY_DISABLED` 明示も選択肢(恒久判断は人間承認・提案どまり)。

## 3. 次アクション(承認後)
1. **A3(antigravity)/ A2(codex fallback)は §C.5 で実測済**(SOT-1533 の強制 primary 実 leg)。残る A1(claude)は
   `workers: implementation=claude` の追試で取得すれば implementation の3 worker 比較が揃う。ランナー実行例:
   `scripts/ai/run_benchmark.sh --repo <fixed> --sha <SHA> --reset --task T4-doc`(S1 の実装済ランナー)→
   出力 metrics JSON の M4/M5/M6 と手採点 M2/M8 を `scoreBenchmarkRun()` に渡し A1 / B2–B3 を埋める。
2. S2 の一部(M4/M5/M6 自動採取)は `run_benchmark.sh` で解消済。残る S4(worker health プリフライト)・
   run_auto.sh の恒常 metrics 出力は別Issueとして起票検討。
3. ~~E4 の条件付きルーブリック分岐を `benchmarkScore.ts` に反映(要 verdict 別)。~~ → ✅実装済。
4. ~~S1 の比較専用ランナー。~~ → ✅本 run で `scripts/ai/run_benchmark.sh` を実装。
5. 数値が揃い次第、role→worker の推奨 `config/worker_roles.json` 改定案を本ファイルに追記。
