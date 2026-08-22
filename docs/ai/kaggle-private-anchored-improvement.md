# Kaggle 改善サイクル：private 一次・二信号一致ゲート設計（恒久対策）

本ドキュメントは、自動起票による Kaggle 改善サイクルの**恒久設計**を定める。対症（提出を増やす等）ではなく、
「何を最適化目標にし、どの観測でそれを判断し、どう過学習を防ぐか」という**目標とフィードバック構造**を規定する。
関連: `docs/kaggle-playbook/`、memory `autonomous-cycle-optimized-wrong-oracle`、`rogii-final-submission-...`。

## 0. 大前提（真KPIと観測量）
- **真のKPI = private スコア**（隠れテストの最終スコア＝実順位を決める）。**競技中は観測不能**。
- 観測できるのは2つの proxy のみ:
  - **leak-free CV**（ローカル・エンティティ/時系列 holdout）… private の一次代理（構築できる競技型に限る）。
  - **public LB**… private のノイジーで時に反転する二次 proxy（rogii: public↔private τ=−1.00 で圏外）。
- したがって **private への閉ループは原理的に作れない**。「観測できる proxy に閉ループを作って最適化を強める」
  発想（public 較正・プローブ強制・自作CVの盲信）は**すべて proxy 過学習＝private 毀損**であり不採用。

## 1. 二信号一致ゲート（昇格判定の中核）
CV と public を private の（部分的に独立な誤差を持つ）2推定量とみなし、**両者が一致した時だけ信頼**する。
片方固有の過学習を他方が反証する。

| CV | public | 解釈 | 判定 |
| --- | --- | --- | --- |
| ↑ | ↑ / ノイズ内 | 両者支持＝転移確度が高い | **昇格候補** |
| ↑ | **↓** | **CV固有の過学習**（private に乗らない疑い） | **棄却** |
| ↓/横 | ↑ | **public-hack / metric-hack** | **棄却**（採用は hedge のみ） |
| ↑ | 未観測 | public 予算温存中 | CVで暫定保持し、最終前に**1回だけ**public 照合 |

- **public の役割 = 目標でなく "反証器"**。`CV↑ & public↓` を検出して CV 過学習を殺す。これが「両方観測する」核心。
- **transfer-trust 監視**: CV↔public の順位相関/gap を継続監視。相関が低い＝どちらも private を代表していない →
  追うのをやめ **CV設計を直す**（oracle 修理）を唯一の作業にする。
- **精度優先の非対称**: 一致要求は recall を下げるが、private では「誤った過学習昇格の害 ≫ 小改善の取りこぼし」
  なので正しい。

## 2. public の使い方の規律（過学習防止）
- **public-best による最終選抜を構造的に禁止**（rogii の public 追い全滅の再発防止）。
- **public は疎に消費**（1日数枠・小部分集合・高分散）。多数候補を public で順位付けするのは public 集合の
  情報漏洩＝過学習。反復チューニング目的で叩かない。
- **最終2枠 = CV最良 × 構造的に独立な hedge**。三角測量は*独立*誤差にしか効かず、train↔private 共通シフト
  （common-mode）は防げない。**hedge が唯一の common-mode 保険**（三角測量は hedge を代替しない）。

## 3. 外部知識（公開ノート/過去上位解法）の取り込み規律
外部知識は **「private に効く仮説の供給源」であって「目標・複製対象」ではない**。取り込みは必ず §1 の
二信号ゲートを通す。**high-public スコア単独では絶対に昇格させない。**

**provenance ゲート（丸ごと採用/verbatim 提出の前に必須）**: 採用対象を静的監査し、**①replay 再構成（記録対戦/特定
submission の replay から固定 schedule を復元・埋め込みの大きな固定 action/lookup テーブル）②license 未宣言/再配布不可
③外部 replay bytes・無ライセンス source の直接コピー**のいずれかなら **verbatim 採用/提出を禁止し fetch-only 扱い**
（＝適応ロジックのみ clean-room 再実装可・成果物を丸ごとは使わない）。理由: そうした成果物は**過去フィールド固有で
live/private に転移せず**（固定手順）、かつ**再配布・提出が規約/ライセンス違反**。**agent/RL の公開上位は大半がこの
replay/clone 再構成ハック**（実障害 SOT-2988: V16-RC5 public~3164 は 720step 固定 action table を replay 再構成・license
未宣言＝提出不可。「2500+ に届かない」の実体は"採用失敗"でなく"転移しない replay 人工物"だった）。判定は台帳へ記録。

- **役割A（改善軸の仮説源・主経路）**: 常時の候補プール。局所軸が枯渇＝プラトー時に escalation で優先度昇格。
  移植手法は CV↑ を第一関門にし、二信号ゲート通過で champion 候補。**public-hack はゲートで自動棄却。**
- **役割B（CV/oracle 設計の修理・最高レバレッジ）**: transfer-trust が低い時、上位解法の**「検証の仕方
  （CV設計・private分布の性質・既知leak）」**を取り込み自分の CV を private 代理として作り直す。＝「何を提出
  したか」でなく「**どう測ったか**」を学ぶ。
- **役割C（到達天井・可搬性の現実認識）**: **「非可搬（彼らの成果物をそのままコピーできない）」を「到達不能」と
  混同しない**（biohub 古典停滞の真因＝この誤認）。上位が GPU 事前学習等でも、**手法クラスが我々に再現可能
  （外部GTで自前学習できる／公開重みをアタッチできる／必要computeが許可されている）なら、そのクラスへ土台ごと
  移行して追う**（§5.5 paradigm 移行）。**到達天井の確定＝maintain は、frontier の手法クラスを我々が実際に試して
  届かなかった時 or 私有データ/資源が必須で入手不能な時だけ**。単に「非可搬だから」で天井を宣言し古典微調整に
  逃げてはならない。
- **役割D（hedge 候補）**: public 高いが CV 未確認の手法は**構造独立 hedge としてのみ**採用可（common-mode 保険）。
  **champion 化は禁止。** metric-hack フラグ付きノートはこの用途に限定。

## 4. 競技型の判定（CV が private を代表できるか）
- **standard（code/表形式）**: leak-free CV が private 代理になり得る → §1〜§3 がフル適用。
- **agent/RL（live matchmaking 等, 例: kaggriculture）**: スコアは**進化する対戦フィールド**に依存し、固定相手の
  CV は最終フィールド(private)を代表**しない**。この型では役割A（champion 化）は成立せず、**役割B（評価系の
  再設計）と役割D（少数多様 hedge を出して静観）へ退避**。CV を無理に強要しない。
- registry `competitions[].cv_representative`（既定 true、agent/RL は false）で本文の指示を切り替える。

## 4.5 探索優先（explore-first portfolio）— 局所最適を抜けるための単位変更
現 champion からの**逐次改変（local A/B・1機能のゲート付き移植）**は、公開首位と大差なのに自 best 付近で停滞する
局所最適に閉じ込める（kaggriculture が public 2786 の agent がある中で 600 付近に停滞した実例）。恒久策として、
**行き詰まり時 または cv_representative=false（agent/RL）では探索の単位を「差分」でなく「独立した複数方向」にする**。

- **多様な独立方向のポートフォリオを 3〜5 本**同時に立てる。各方向は**構造的に独立**で現 champion の変種にしない:
  - **役割A'＝可搬な公開上位 baseline/agent を"丸ごと"採用**（1機能のつまみ食いでなく土台ごと差し替え・出典明記・
    旧を hedge 温存）。**⚠ ただし丸ごと採用は"候補方向の生成"であって、その high-public を private の証拠にしない**
    （rogii: public↔private τ=−1.00 逆転で public 首位が private 圏外＝過学習全滅）。「public が上回る＝champion 化」は
    禁止で、昇格は §1 二信号ゲート（**CV↑ 裏付け必須**）を通す。CV が裏付けない public 跳ねは §2/役割D の hedge 扱い、
    **cv_representative=false では採用は賭け＝旧を必ず hedge 温存し全賭けしない**。＝**探索は広く（public 上位も採る）／
    選抜は決して public-best でしない**。
  - 根本的に異なる戦略／アーキテクチャ、問題定式化の変更、上位ノートの CV/検証設計の移植（役割B）。
- 各方向は**それ自身の実力で評価**（現 champion の panel で「発火するか」でなく、その方向の実スコア/CV を直接測る）。
  方向間で比較して**筋の良い方向を特定してから exploit（深掘り）**へ移る（explore→exploit）。
- 昇格・提出は §1 の二信号ゲート／§2 の hedge 規律に従う（探索は候補生成の多様性・評価はローカル一次KPI）。
- 実装: `buildExplorationBanner`（本文冒頭バナー。trigger=isImprovementStuck || !cvRepresentative）。

## 5. escalation・飽和・天井の正直さ（空回り防止）＝サイクル内自己監査（決定論の状態機械）
人手の「監査→型の特定→是正」を**サイクル自身に内在化**する。毎起票時に **on-disk 証拠（experiment_ledger.jsonl）から
停滞の型を決定論的に算出**（`computeStagnationForensics`）し、型に応じた是正指示を本文へ自動注入
（`buildCorrectiveDirectiveBanner`）。LLM判断ゼロ＝監査可能。

**自己監査メトリクス**: `externalAdoptAttempts/Promoted/Inconclusive`（外部知識"採用"軸の試行/採用/研究止まり数・
内部oracle/policy改善とは区別）・`wholesaleAdoptOutcome`（丸ごと採用=役割A'の最新確定結果 promoted/rejected/never）・
`portabilityVerifiedNonPortable`（可搬性検証が非可搬=天井と結論した台帳エントリの有無）。

**是正 directive（排他・優先順）**:
- **型E パラダイム移行（PARADIGM SWITCH・最優先）**: registry `frontier_paradigm` 宣言あり × `paradigm_reachable=true` ×
  未着手（台帳 axis に "paradigm" 無し）→ **同クラスの微調整をやめ frontier の手法クラスへ土台ごと移行**（自前学習/公開重み）。
  **宣言そのものが「そのクラスへ移る」決定**なので停滞カウントでは gate しない（着手すると axis "paradigm" が付き自動で止む）。
  未宣言の競技で自動検知するための停滞シグナル `cyclesSinceLastPromotion` は本文に併記（人間が frontier_paradigm を宣言する契機）。
  **「非可搬≠到達不能」**: クラスが再現可能なら追う。**maintain はそのクラスを実際に試して届かなかった時だけ**。
  「古典で停滞し続けた／非可搬を到達不能と誤認して同クラスを磨き続けた（biohub 実障害）」の恒久対策。
- **型B 到達天井（PIVOT）**: `wholesaleAdoptOutcome=rejected` × `portabilityVerifiedNonPortable`（かつ frontier paradigm が
  到達不能 or 着手済で頭打ち＝型E が発火しない）→ 同型 classical lever の反復移植を禁止し、**役割B（独立 public アンカー
  獲得／oracle 再設計）** か **mode:maintain＋compute 再配分**へ固定。
- **型D 可搬性再検証**: `wholesaleAdoptOutcome=rejected` × 未検証 → 天井を主張する前に**可搬性を1回だけ再検証**する子Issueを
  立て、結論を axis に "portability" を含めて台帳へ記録（次サイクルの型B/A の入力）。
- **型A ADOPT+SUBMIT 強制**: 外部採用を規定回（`CORRECTIVE_EXTERNAL_ADOPT_ATTEMPTS_MIN`）試みたが promoted=0 ＝
  「研究して inconclusive を積むだけ」→ **research 禁止・最強の可搬公開 baseline を丸ごと採用+提出+観測**（旧は hedge 温存・
  §4 の cv_representative=false 規律をデータ駆動で全コンペへ一般化）。budget/rogii hedge は必ず経由。
- **型C 前提死んだ子の自動解消（reaper）**: 改善親の子が Blocked で、**他に動いている子が無い**（前提を供給しうる作業なし）
  なら premise-dead として自動 Cancel し親を再開（`cancelStrandedBlockedChildren`）。In Progress の兄弟がいる間は触れない。
  find→port→judge 分解で find が negative 完了→port/judge が Blocked stranding する実障害（SOT-2926/2928）の恒久解。

**人間可読の統合記録（`docs/ai/STRATEGY_AND_ROADMAP.md`・全コンペ必須）**: 機械可読な `experiment_ledger.jsonl` とは別に、
**人間が1枚で「コンペの性質／現状／これまでの試行錯誤と結果／確定した結論／今後の方針」を読める単一の真実源**を各 target
repo に維持する。**毎サイクルの集約フェーズで作成/更新を必須化**（kaggle=buildIssueBody step5＋受け入れ条件、signate/nedo=
nedo_loading_cycle_draft step7＋受け入れ条件）。節構成は 0.性質/制約/指標・1.現状サマリ・2.試行錯誤履歴と結果・3.確定した結論
（天井/パラダイム/律速）・4.今後の方針・5.参照。古い記述は消さず追記（判断の変遷が追えること）。今後の新規コンペも同じ
ドクトリンで自動的にこの文書を持つ。

ladder 完全枯渇 ＋ 制約下の到達天井 < frontier が証拠付きで確認されたら **mode:maintain＋compute 再配分**。
**健全性指標 = 「CV↑×public非矛盾（cv_rep=true）／強い可搬公開 baseline の採用+提出+観測（cv_rep=false）が起きているか」**。
提出数や public スコアそのものを成果にしない。

## 6. 敵対的レビュー（本設計自体の限界・明示）
1. **common-mode**: CV と public が同じ分布シフトを共有すると揃って private を外す。三角測量は独立誤差にのみ有効
   → **hedge が必須**（§2）。
2. **public 予算/分散**: 疎に使うほど情報は少ない。反復照合は過学習 → 疎・最終照合のみ（§2）。
3. **agent/RL 型**: CV が private を代表しない → §4 で退避。
4. **自作 proxy の gaming**: ループは一致規則も回避し得る（両 proxy に効くが private に無効な共通ズレ）→ 複数CV
   スキーム・leak-free 強制・per-entity 無退行で proxy 整合性を担保。
5. **観測不能性**: private は競技中測れない以上、**いかなる対策も private 改善を保証しない**。本設計の本質は
   「最適化を強める」ではなく**認識論的謙抑＋頑健性（CV一次・public反証・hedge・型/天井の正直さ）**。
6. **自己監査（§5）の誤判定**: 軸の型分類は台帳の axis 文字列の正規表現＝誤検知しうる。緩和＝型A/B は「実際に採用を
   試して確定（promoted/rejected）した台帳証拠」を要求し推測で発火しない・型B の天井宣言は型D の可搬性再検証通過を
   前提にする（推測 maintain の禁止）・型C は「他に動いている子が無い」ときだけ発火（In Progress の兄弟がいれば触れない）。
   閾値は「gap 実在＋可搬 baseline 未採用」で門を絞り、毎サイクル提出強制にならないようにする。

## 7. 実装状態（本設計への対応）
- 済: 提出枠効率化(reserve/spacing/改善ゲート)・公開ノート供給＋過学習フラグ(PR#404-409)。
- 済: 昇格ゲート**二信号一致**・外部知識**4役割**・`cv_representative` 型フラグ(PR#410)。
- 済: `cv_representative=false` を『採用+提出+観測』へ(PR#418)。
- 済: **サイクル内自己監査＝決定論状態機械**（`computeStagnationForensics`＋`buildCorrectiveDirectiveBanner` 型A/B/D・
  reaper 型C `cancelStrandedBlockedChildren`。§5）＝ escalation 状態機械化＋健全性メトリクス自動通報の実装。
- 追って: transfer-trust の決定論算出、mode:maintain の自動提案（型Bからの昇格）。

**要旨: private は観測不能。CV を private 代理の一次に、public を独立反証器に、両者一致だけ昇格し、
残余不確実性は構造独立 hedge で守る。外部知識は仮説源として同ゲートを通し、high-public 単独では昇格させない。**
