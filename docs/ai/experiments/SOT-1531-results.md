# SOT-1531 ベンチマーク結果

> 記録の透明性について: 本キットは制約付きワーカー(implementation role)として作成した。
> **ワーカーは他ワーカー(codex/antigravity)を実ディスパッチできない**(`AI does not call AI`)ため、
> codex/antigravity の live run 数値はここでは**埋めず** `pending(要オーケストレータ実行)` と明記する。
> 数値の捏造はしない。実行手順は `README.md` 参照。

## A. implementation ベンチマーク(タスク T4-doc、M1–M8)

`scoreBenchmarkRun()` で合成スコアを算出(重みは `DEFAULT_WEIGHTS`)。

| run | task | worker | M1ゲート | M2充足率 | M3デバッグ | M4時間 | M5中断 | M6差分 | M7介入 | M8定性 | 合成Score | 備考 |
|-----|------|--------|---------|----------|-----------|--------|--------|--------|--------|--------|-----------|------|
| A1 | T4-doc | claude | — | — | — | — | — | — | — | — | pending | 要オーケストレータ実行(`workers: implementation=claude`) |
| A2 | T4-doc | codex | 合格 | 100% | 0 | **~132s** | 0 | 追記のみ(1節) | 不要(自走) | 4/5 | **完遂** | **実測(SOT-1533 実 leg)**: agy handoff 後に fallback 登板し T4-doc を完遂。04:17:22→**04:19:34 `WORKER_DISPATCH_DONE worker=codex`**。window-runner **PR#6**、`npm test` 22 pass。強制 primary 実験(`workers: implementation=antigravity>codex`)の実データ |
| A3 | T4-doc | antigravity | ✗ | 0% | — | ~40s で失敗 | **中断(exit75)** | 成果物なし | 不能 | 採点不能 | **未完遂(中断)** | **実測(SOT-1533 実 leg・決定的)**: 04:16:42 agy を **強制 primary で実ディスパッチ**(directive `implementation=antigravity>codex`)→ 04:17:22 `Error: authentication failed or timed out` → `WORKER_HEALTH antigravity CHRONIC auth failure`(auth-unhealthy **再マーク** until epoch 1783225942=04:32:22 UTC)→ crash exit1 → **exit75 handoff**。**再認証後・実到達しても同一 chronic auth で失敗＝leg 未成立**(下 §C.5) |

記入手順: 各 run 後に `git diff --stat` / `docs/ai/auto_logs/` タイムスタンプ / handoff 数から M1–M8 を
埋め、`scoreBenchmarkRun()` で Score を算出して反映する。

## B. decomposition ベンチマーク(D-live、R1–R7 定性ルーブリック)

**実際に実行された1件**を記録する: 本パイプライン run で `decomposition` role が
SOT-1531 自身の分解要否を判断した output(DC-claude)。基準解 = **不要**
(単一の実行＋分析成果物で独立機能・別PR単位なし)。`scoreDecompositionRubric()` で採点。

> **E4 適用済**: verdict='not-required' の run は `scoreDecompositionRubric` が **R1/R6/R7 のみ**で採点し
> 3軸平均を 7..35 スケールへ正規化する（非該当の R2–R5 を「満点扱い」しない）。B1 は verdict-aware で再採点。

| run | task | worker | 要否一致 | verdict | R1 | R6 | R7 | (R2–R5) | 定性合計(正規化) | 実効 | 備考 |
|-----|------|--------|----------|---------|----|----|----|---------|------------------|------|------|
| B1 | D-live(SOT-1531) | claude | ○(不要=基準解一致) | not-required | 5 | 5 | 5 | 非該当 | 35 | 35 | 判断コメント投稿+In Progress更新済。適用軸=R1/R6/R7（`appliedAxes`）。R2–R5 は子Issue無で非該当（採点対象外） |
| B2 | D-live(SOT-1531) | codex | — | — | — | — | — | — | pending | pending | 要オーケストレータ実行(`workers: decomposition=codex`) |
| B3 | D-live(SOT-1531) | antigravity | — | — | — | — | — | — | pending | pending | 要オーケストレータ実行(`workers: decomposition=antigravity`) |

> ⚠ B1 は**単一ワーカーの自己観測**であり、B2/B3 が未実行のため**比較にはならない**。worker 間の
> 優劣結論は codex/antigravity の同一タスク実行後にのみ導ける。B1 は「キットが実データを採点できる」
> ことの実証であり、B1 単独で decomposition の推奨 worker を決めることはしない。

## C. 実測ベンチマーク — dispatcher 実行コーパスの観測(実データ・捏造なし)

> A/B の controlled live run は制約付きワーカーでは実行できない(`AI does not call AI`)。
> その代替として、**既に走った実 run の記録** `docs/ai/auto_logs/auto_runner.log` を集計し、
> 3 worker の**実運用での可用性・信頼性**を採点する。これは同一タスクを揃えた統制実験ではなく
> **観測(natural experiment)**である点に注意(下の交絡を明記)。

**集計窓**: 2026-07-01 05:22 〜 2026-07-05 03:52(約4日、`grep` 実測)。**agy 再認証(2026-07-05 03:27)後に再集計**。
**母数**: `WORKER_DISPATCH_DONE`(=あるワーカーがその role を完遂) 147件、
`WORKER_DISPATCH_HANDOFF`(=非応答で次ワーカーへ) 7件、`WORKER_DISPATCH_EXHAUSTED`(=全滅) 5件。

### C.1 worker 別 完遂(win)数 — 実運用信頼性の代理指標

| worker | 完遂 role(件数) | 合計 win | handoff(非応答) | 解釈 |
|--------|------------------|----------|-----------------|------|
| claude | decomposition28 / task-check23 / implementation21 / acceptance19 / verification18 / linear-report15 / github15 | **139** | 3 | 全 role で primary(chain index0)。ほぼ全タスクを完遂。稀に usage-limit で非応答 |
| codex | task-check6 / verification2 | **8** | 0 | **fallback(index1)で登板し task-check/verification を確実に完遂**。登板時の信頼性は高い |
| antigravity | (なし) | **0** | 4 | **一度も完遂せず**。SOT-1529 implementation で `ANTIGRAVITY_AUTH_UNHEALTHY`(chronic auth)により4回とも即 handoff。**再認証後も 0 完遂**だが理由が変化(§C.4 参照): auth 障害ではなく既定 chain で agy まで到達していないため |

補助(再集計時点): `ANTIGRAVITY_AUTH_UNHEALTHY` の最終出現は 2026-07-04 16:15(SOT-1529、chronic-auth マーカー epoch 1783181712)。**再認証以降(03:27〜)は agy の実ディスパッチ試行そのものが 0**。

### C.2 M1–M8 への写像(worker 別・観測ベース、定性込み)

| worker | M1 ゲート | M5 中断/可用性 | M7 自走 | M8 定性(登板観測) | 総評 |
|--------|----------|----------------|---------|--------------------|------|
| claude | 完遂多数=高 | usage-limit で稀に中断(account-global) | 高 | 4/5(本コーパスの成果物の大半) | 既定 primary として妥当。唯一のリスクは共有 usage-limit |
| codex | 完遂=高(8/8登板成功) | 中断0=高 | 高(task-check/verification) | 4/5(検証・タスク確認で確実) | **検証系のフォールバック/一次候補として有力** |
| antigravity | **0完遂=不可** | 4/4 auth 失敗=最低 | 不能 | 採点不能(成果物なし) | **現状 chronic auth で比較不能=非稼働**。復旧まで chain から外す判断も可 |

### C.3 交絡と限界(結論を歪めないための明示)

- **交絡①(chain 順)**: 現行 `config/worker_roles.json` は全 role で claude が index0。claude の高 win は
  「一次で必ず試される」ためで、**head-to-head の品質優劣ではない**。codex/antigravity は claude 非応答時のみ登板。
- **交絡②(タスク非統制)**: 各 win は別々の Issue。同一タスクを3 worker に与えた統制比較ではないので、
  **速度・差分品質(M4/M6)の worker 間比較は本節からは導けない**。それは A(controlled)run が必要。
- **それでも言える実データ結論**:
  1. **antigravity は現状ベンチマーク対象として非稼働**(0完遂/4 auth失敗)。3-worker 比較は事実上 claude vs codex。
  2. **codex は task-check / verification を確実に完遂**(8/8 登板成功、中断0)→ この2 role の一次候補として有力。
  3. claude は全 role を高信頼で完遂するが **usage-limit がアカウント横断の単一障害点**。

## C.4 agy 再認証後の状態(2026-07-05 03:27 再認証 → 本 run で再集計)

最新指示「3 worker（claude / codex / agy）の比較ベンチマークを agy 込みで再実行」を受け、agy 再認証後の
実 run コーパスを再集計した(母数 130→147、窓 〜03:52)。**捏造なし・実 grep 結果**:

| 観測項目 | 再認証前(01:24 集計) | 再認証後(03:52 再集計) | 判定 |
|----------|----------------------|------------------------|------|
| agy 完遂(win) | 0 | **0**(変化なし) | leg 未取得 |
| agy 実ディスパッチ試行 | SOT-1529 で4回(全 exit75) | **0**(03:27 以降 agy を試行した run なし) | 未到達 |
| chronic-auth マーカー | active(最終 07-04 16:15) | **消失**(起動ゲート全クリア) | 障害は解消 |
| agy 起動ゲート | auth-unhealthy で即 exit75 | auth-unhealthy 無 / cooldown 無 / disable 無 / CLI 有 | **bucket A(復旧見込み)** |

**核心**: agy の chronic-auth ブロッカーは解消済(ゲートは全クリア=復旧見込み)。しかし **agy 完遂は依然 0**。
理由が**変わった**——以前は auth 障害で即 handoff、**今回は「そもそも agy が呼ばれていない」**。SOT-1531 の
既定 chain は全 role `[claude codex antigravity]` で、claude(index0)が毎 role 勝つため agy(index2)に
到達しない。つまり**「agy 込みの再ベンチ」を成立させるには、`workers: <role>=antigravity` の per-issue
ディレクティブで agy を primary(index0)に強制**し、実際に agy にタスクを完遂させる必要がある。

**制約付きワーカーの限界(正直な開示)**: 本 leg(agy を強制 primary にした controlled run)は、
implementation role の制約付きワーカーからは**実行できない**(`AI does not call AI`、`run_worker.sh`/
`run_benchmark.sh` 起動禁止)。数値の捏造はしないため A3/B3 は引き続き `pending(要オーケストレータ/人間実行)`
とし、実行手順のみ下に固定する。

### C.4.1 agy leg を実際に取るための実行手順(オーケストレータ/人間シェル用)

1. Linear の SOT-1531 に per-issue ディレクティブを1行入れて agy を primary に強制する:
   `workers: implementation=antigravity>claude, verification=antigravity>codex, decomposition=antigravity>claude`
   (`>` はフォールバック。agy が万一また exit75 でも従来ワーカーに戻り run は継続)。
2. 固定タスクで比較ランナーを回す(制約外のシェルから):
   `scripts/ai/run_benchmark.sh --repo <fixed> --sha <SHA> --reset --task T4-doc`。
3. 出力 metrics JSON(M4 時間 / M5 中断=handoff+exhausted / M6 diff numstat)＋手採点 M2/M8 を
   `scoreBenchmarkRun()` に渡し、本ファイル A3(implementation)/ B3(decomposition)を埋める。
4. agy が今度は `exit 75` にならず `WORKER_DISPATCH_DONE ... worker=antigravity` を出せば **agy leg 取得成功**。
   なお exit 75 なら §C.1 と同じく失敗モード(ログ抜粋)を残し、agy を chain 末尾 or `ANTIGRAVITY_DISABLED` 明示に。

## C.5 agy 強制 primary の実 leg 取得(SOT-1533・2026-07-05 04:16〜04:19)【決定的】

§C.4 で「agy leg には強制 primary directive が必須」とした手順を、**子 Issue SOT-1533**
(`workers: implementation=antigravity>codex`)の実パイプラインで**実際に取得できた**。これは過去 run で
一度も取れなかった **agy を implementation の一次に強制した controlled な実 leg** である(捏造なし・ログ実測)。

| 時刻(UTC) | イベント(ログ実測) |
|-----------|--------------------|
| 04:16:42 | `dispatch: role=implementation chain=[antigravity codex]` → **agy を primary で実ディスパッチ**(再認証後、初の実到達) |
| 04:17:22 | `[agy] Error: authentication failed or timed out`(~40s) |
| 04:17:22 | `[WORKER_HEALTH] antigravity CHRONIC auth failure — re-authentication required; marked auth-unhealthy until epoch 1783225942`(=**2026-07-05 04:32:22 UTC**) |
| 04:17:22 | `WORKER_NONRESPONSE: antigravity (crash (exit 1))` → `WORKER_DISPATCH_HANDOFF ... worker=antigravity exit=75 -> next in chain` |
| 04:17:22 | `[codex]` fallback 登板 |
| 04:19:34 | `WORKER_DISPATCH_DONE role=implementation worker=codex`(~132s) → window-runner **PR#6**、`npm test` 22 pass |

**決定的な所見(従来仮説の反証)**: §C.4 までは「agy 完遂 0 は**既定 chain で未到達**だから(auth は復旧済)」
と解釈していた。しかし **agy を強制 primary にして実際に到達させると、再認証後も同一の chronic auth
failure(exit 1→75)で即失敗**し、auth-unhealthy マーカーが**再設定**された。つまり:

- **「起動ゲートがクリアに見える(marker 消失・cooldown 無・disable 無・CLI 有)」は復旧を意味しなかった**。
  実ディスパッチ時に CLI が認証に失敗する状態は継続している(marker は失敗の**結果**として都度再付与される)。
- 従来の「未到達だから 0」仮説は**部分的に誤り**。到達させても 0=**agy は現状 implementation を完遂できない**
  (T4-doc という最小・低リスク DOC ですら)。
- **codex の fallback は堅牢**: agy handoff 後 ~132s で T4-doc を完遂し PR#6 を生成(chain の耐障害性が機能)。

**結論の更新**: agy は「auth 復旧済・未実測」ではなく **「実測の結果、再認証後も実ディスパッチ時に
chronic auth で完遂不能」**。当面は chain 末尾維持で害はない(実際 fallback で codex が拾う)が、
無駄な ~40s の失敗待ち+誤解を招く marker 再付与を避けたいなら `ANTIGRAVITY_DISABLED` 明示も選択肢。
恒久判断は人間承認(提案どまり)。

## 集計(controlled A/B は pending、observational C は実測済)
- **C(観測)**: 上記の通り実データで採点済(agy 再認証後に再集計、母数147)。結論=**agy は chronic-auth 解消
  (ゲート全クリア=復旧見込み)だが既定 chain で未到達のため完遂 0 のまま**→ agy leg には強制 primary directive が必須。
  **→ §C.5 で強制 primary の実 leg を取得: 到達しても再認証後同一 chronic auth で exit75=完遂不能と判明(仮説反証)**。
  codex は検証系で有力かつ implementation fallback も堅牢(T4-doc を ~132s 完遂)、claude は usage-limit が唯一のリスク。
- **A/B(統制)**: 複数ワーカーの同一タスク数値が揃った後、worker 別平均スコアと要否一致率を出し、
  role→worker の推奨 `config/worker_roles.json` 改定案を `SOT-1531-analysis.md` に追記する
  (M4/M6 の統制比較は A run 実行後にのみ確定)。
