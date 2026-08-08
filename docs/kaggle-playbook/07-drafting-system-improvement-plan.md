# 7. 定期Kaggle解法起票システム 改善計画（PLAN・人間レビュー待ち）

- 状態: **提案**（2026-08-07 起案。承認後に Linear 親Issue + 子Issue に分解して実施）
- 背景: ROGII 敗北の根本原因は個別の実装ミスではなく、**起票システム自体が public 過学習を制度的に
  誘発する構造**だったこと（[事後分析](06-case-rogii-postmortem.md)）。playbook の教訓を「読む知識」から
  「システムが強制する契約」へ昇格させる。
- 対象: `src/lib/kaggleImprovement.ts`（起案本文）/ `src/lib/kaggleImproveMaterial.ts`（材料収集）/
  `scripts/ai/kaggle_targets_registry.json` / `scripts/ai/kaggle_targets_submit.sh` / design/README.md §42-51
- 現況: 定期起票は registry `enabled:false` で全停止中（人間指示）。**本改善の実施後に再開する**のが自然な順序。

---

## 敗因 → システム欠陥のマッピング

| ROGII で起きたこと | それを許したシステム上の欠陥 | 対策 |
|---|---|---|
| public 6.4 を信じ private 9.3 で沈没 | 起案本文が「**Leaderboard 順位（一次KPI）**」と明記(kaggleImprovement.ts:758) | P1 |
| leak-free CV(8.3/11.2)を持ちながら無視 | CV の収集・比較・乖離警告が材料に無い | P1/P2 |
| 1定数違いの提出6本→best public 選抜 | 昇格ゲートに CV・頑健受容テストが無い | P3 |
| 最終2枠が両方 public 最良 | 収束モード(:714-722)に選抜分散ルールが無い | P4 |
| 締切日にボーダー0.003のノイズ追い | メダル指令の「翻訳」規範が無い / 人間確認点が無い | P4/P5 |
| 可視CSV byte比較で「blend inert」誤結論×2 | fingerprint gate が可視 submission.csv の sha256(kaggle_targets_submit.sh:110) | P6 |
| 定式化(点推定)自体が敗因なのに微調整を継続 | escalation ladder(:780-783) に定式化見直し段が無い | P7 |

---

## P1. KPI 階層の再定義 — 「LB順位一次」を「leak-free CV 一次」へ（最重要）

**現状**: `buildIssueBody` が `### Leaderboard 順位（一次KPI）` を材料の先頭に置き、design §42-51 も
LB 順位を primary KPI とする。hidden private split では public 最適化＝過学習を制度化してしまう。

**変更**:
1. registry の competition に **`validation` ブロック**を追加:
   ```json
   "validation": {
     "primary": "cv",                  // "cv" | "lb"（依存: hidden private split の有無）
     "cv_report_path": "docs/ai/cv_report.json",   // target repo 側の CV 契約
     "tail_heavy_metric": true         // RMSE/SSE系: 頑健受容テスト必須フラグ
   }
   ```
   `__fields__` に「hidden private split のコンペは必ず `primary: "cv"`」と明記。
2. target repo 側に **CV 契約**を新設: 各サイクルの champion/candidate は
   `docs/ai/cv_report.json`（`{cv_scheme, entity_unit, folds, score, per_entity_scores}`）を必ず更新。
   entity 単位 hold-out（行単位禁止）をスキーマで要求。
3. `buildIssueBody` の材料セクションを再構成:
   - `### 検証階層（一次=leak-free CV / 二次=public LB）` を先頭に。CV スコアと public best を並記し、
     **gap = |CV − public|** を cron が計算して埋め込む。
   - gap がスコアの O(10%) を超えたら **`⚠ 乖離警告: 悲観側(CV)を信じよ。public追い禁止`** を自動挿入。
4. 起案本文に playbook への参照を追加: 「実施前に `docs/kaggle-playbook/README.md` のチェックリストを通過」。

**受け入れ条件**: 起案本文に「一次KPI=LB順位」の文言が残らない。gap 計算のユニットテスト。
registry バリデーション（validation ブロック欠落時は fail-safe に `primary:"cv"`）。

## P2. 材料収集の拡張（cron 側）

**現状**: `collectMaterial` 相当は LB 順位 / 前回提出 / 台帳 / 完了Issue / 失敗ログのみ。

**変更**（`kaggleImproveMaterial.ts`）:
1. **CV レポート読取**: target repo の `cv_report.json` を読み、materials に `cvSummary` を追加。
2. **gap 履歴**: submissions CSV（publicScore）× cv_report 履歴から gap の推移を digest 化。
   gap が拡大傾向なら「汎化リスク増大」を起案本文に警告表示。
3. **参照実装スコア台帳**: 公開NB/参照解法を移植した場合、その公称 public を registry か台帳に記録し、
   port が参照を有意に上回ったら **過学習疑い警告**を自動挿入（playbook P5）。
4. （締切後回顧用）privateScore 列の取り込み — コンペ終了時に public/private gap を自動で failure-log
   候補として出力（aggregate-outcomes の promotion candidate に接続）。

**受け入れ条件**: 各 digest のユニットテスト。cv_report 欠落時は「CV未整備 — 最初の子Issueで CV 構築を
必須とする」文言が本文に入る（fail-safe: CV が無い repo は改善軸より先に CV を作らせる）。

## P3. 昇格ゲートの強化 — 頑健受容テストの契約化

**現状**: 台帳への記録契約（promoted/rejected/inconclusive）はあるが、判定基準は worker 任せ。

**変更**:
1. 起案本文の「実施内容」に昇格3条件を明文化:
   - (a) **leak-free CV の改善**（一次）
   - (b) `tail_heavy_metric` のコンペでは **頑健受容テスト**: per-entity 損失差 `g_w` を |g_w| 降順に除去し、
     改善が **public LB サイズ超**まで生存すること（k* > |public|）
   - (c) public 非劣化（二次 sanity。**微改善は昇格根拠にしない**）
2. 台帳スキーマ拡張: `cv_score`, `public_score`, `gap`, `k_star` フィールドを追加（必須化は tail_heavy のみ）。
3. control-plane に頑健受容テストの**参照実装**を提供: `scripts/ai/robust_acceptance.py`
   （入力: base/treat の per-entity 損失 CSV、出力: k* とカーブ）。target repo からコピーせず呼べる形。

**受け入れ条件**: 参照実装のユニットテスト（合成データで k* が既知のケース）。起案本文テンプレの
スナップショットテスト更新。

## P4. 収束モードの選抜分散ルール + 締切運用

**現状**: 収束モード文言(:718-722)は「リスク分散」と言うのみで具体則が無い。

**変更**（convergeMode テンプレ差し替え）:
1. **最終2枠 = CV最良 × hedge**（性質の異なる候補）。**両方 public 最良の選抜は禁止**と明記。
2. 提出枠・採点遅延の運用則: 日次上限の1枠を最後まで温存し、締切 2.5h 前の drop-dead で無条件提出。
   締切間際の提出は採点が締切後になり自動選抜に入らない可能性がある旨と、Web での手動選抜依頼
   （人間へのコメント）を必須化。
3. ボーダー微差（LBノイズ幅）追い禁止: 「cutoff との差がノイズ幅未満のとき、それを目標にした
   子Issue を起票しない」。

## P5. 人間コメントの尊重（ブロッキングゲートは置かない）【2026-08-07 人間指示で改訂】

**方針変更**: 人間の承認待ちで止まる **human gate は導入しない**（完全自動を維持）。代わりに、
**人がIssueにコメントしたら必ず読まれ・反映される**ことをシステム契約にする。

**変更**:
1. **final-selection report 契約**（維持）: converge/締切フェーズの提出前に、親Issue へ
   `CV最良=X / public最良=Y / gap=Z / 選抜=[CV最良, hedge] / 理由` の定型コメントを投稿する。
   これは人間が介入する**機会**の提供であり、返答を待たない（安全側デフォルトで進む）。
2. **意思決定点での最新コメント再取得を契約化**: 親Issue の (a) 改善軸選定時 (b) 親再開run の集約時
   (c) 提出直前 の3点で、**Issue のコメントを再取得し、新しい人間コメントがあれば最新指示を優先**する
   （newest-wins。既存の worker directive / New Instructions From Linear ポリシーの徹底を、起案本文の
   実施内容に明文化する）。
3. **汎用 pause/stop directive**: コメント先頭行の `cycle=pause` / `cycle=stop` / `submit=hold` を
   directive parser（`src/lib/workerRoleDirective.ts` と同系）で解釈し、提出・続行を止められるようにする
   （人間が「待った」を掛ける軽量手段。auto-accept の hold と同様、独立した短文コメント先頭行で書く —
   長文中の埋め込みは検出されない既知の罠を仕様として明記）。
4. メダル圏が現実的と cron が判定した場合の Discord 通知（notify_discord 既存基盤）は維持 — 気づく機会を
   増やすが、承認は要求しない。

## P6. fingerprint gate の修正（可視CSVの罠）

**現状**: `kaggle_targets_submit.sh:110` が可視 `submission.csv` の sha256 で dedup。Code コンペで
可視を全上書きする層があると **hidden 挙動が変わっても同一 fingerprint** になり、(a) 新レバーの提出が
dedup で弾かれる / (b) byte 同一を根拠にレバーを誤 CLOSE する（cycle11 事故）。

**変更**:
1. fingerprint の対象を **kernel ソース（notebook の code cells）+ pinned datasets + version** の hash に変更
   （可視出力でなく「実行される計算」を同一性の単位にする）。registry `submit.kind: "kernel"` の
   ターゲットに適用。CSV 直接提出のターゲットは従来通り。
2. 起案本文/子Issue テンプレに「**レバー生死は hidden LB スコア差でのみ判定**（可視 byte 比較禁止）」を明記。

**受け入れ条件**: kernel-hash fingerprint のテスト。既提出履歴との後方互換（旧 sha256 行を壊さない）。

## P7. escalation ladder への「定式化見直し」段の追加

**現状**(:780-783): 局所チューニング → データ/oracle整備 → アーキテクチャ変更 → 外部知識取り込み。

**変更**: ladder に2段を追加し、次の順へ:
1. 局所チューニング
2. データ/oracle 整備（CV 再アンカリング）
3. **汎化ギャップ診断**（local↔public gap の分解: どの層が gap を作っているか。gap を作る層＝
   public 特化較正の除去を軸候補にする）
4. **問題定式化の見直し**（点推定 vs 条件付き分布 / 恒等式・物理制約の発見 / 合成データ —
   [playbook 03](03-problem-formulation.md) をチェックリストとして参照）
5. アーキテクチャ変更
6. 外部知識取り込み（公開NB・write-up。**port が参照 public を上回ったら過学習疑い**）

---

## 実施フェーズ（子Issue 分解案・依存順）

| # | 子Issue（機能名） | 主対象 | 規模 |
|---|---|---|---|
| 1 | 起案本文のKPI階層をleak-free CV一次へ再定義する（P1+P7 文言） | kaggleImprovement.ts + テンプレテスト | 中 |
| 2 | 材料収集にCVレポート/gap/参照スコア警告を追加する（P2） | kaggleImproveMaterial.ts + registry validation | 中 |
| 3 | 頑健受容テスト参照実装と台帳スキーマ拡張（P3） | scripts/ai/robust_acceptance.py + docs | 中 |
| 4 | 収束モードの選抜分散・締切運用＋人間コメント尊重（P4+P5） | kaggleImprovement.ts + workerRoleDirective系 + registry | 中 |
| 5 | kernel-hash fingerprint への移行（P6） | kaggle_targets_submit.sh + テスト | 小-中 |

全子Issue は **Opus 担当**（本文先頭に `workers: solo=claude:opus, handoff=off` を記載）。

- design/README.md §42-51 の「LB順位=primary KPI」記述の改訂は #1 に含める（CLAUDE.md の関連節も）。
- すべて control-plane 内の変更（target repo 側は CV 契約ドキュメントのみ）。既存テスト
  `src/__tests__/kaggleImprovement.test.ts` / `kaggleImproveMaterial.test.ts` を拡張。
- **再開手順**: #1・#2 マージ後に registry `enabled:true` + schedule 復元（人間指示で）。#3-#5 は再開後も可。

## 非目標
- 提出の完全自動を止めること（human gate は registry opt-in のコンペのみ）。
- 既存 2層構造（cron は LLM を呼ばない）の変更。rotation/allocation の変更。
- モデル実装そのもの（AnchorCNN 的アプローチの採用判断は各コンペの改善サイクル内で行う）。

## リスク
- CV 契約が未整備の repo では初回サイクルが「CV 構築」に消費される（意図的: CV 無しの改善軸選定こそが
  rogii の敗因。fail-safe として本文に明示する）。
- kernel-hash fingerprint は notebook の非機能変更（コメント等）でも別物と判定する（過剰提出リスク）
  → 提出は従来通り親Issue の1提出契約でレート制御されるため許容。
