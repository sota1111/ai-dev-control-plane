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

- **役割A（改善軸の仮説源・主経路）**: 常時の候補プール。局所軸が枯渇＝プラトー時に escalation で優先度昇格。
  移植手法は CV↑ を第一関門にし、二信号ゲート通過で champion 候補。**public-hack はゲートで自動棄却。**
- **役割B（CV/oracle 設計の修理・最高レバレッジ）**: transfer-trust が低い時、上位解法の**「検証の仕方
  （CV設計・private分布の性質・既知leak）」**を取り込み自分の CV を private 代理として作り直す。＝「何を提出
  したか」でなく「**どう測ったか**」を学ぶ。
- **役割C（到達天井・可搬性の現実認識）**: 上位が GPU 事前学習等で**非可搬**なら到達天井を確定し、無益な
  再移植を避け、可搬面（古典前後処理）に集中 or maintain/再配分（§5）。
- **役割D（hedge 候補）**: public 高いが CV 未確認の手法は**構造独立 hedge としてのみ**採用可（common-mode 保険）。
  **champion 化は禁止。** metric-hack フラグ付きノートはこの用途に限定。

## 4. 競技型の判定（CV が private を代表できるか）
- **standard（code/表形式）**: leak-free CV が private 代理になり得る → §1〜§3 がフル適用。
- **agent/RL（live matchmaking 等, 例: kaggriculture）**: スコアは**進化する対戦フィールド**に依存し、固定相手の
  CV は最終フィールド(private)を代表**しない**。この型では役割A（champion 化）は成立せず、**役割B（評価系の
  再設計）と役割D（少数多様 hedge を出して静観）へ退避**。CV を無理に強要しない。
- registry `competitions[].cv_representative`（既定 true、agent/RL は false）で本文の指示を切り替える。

## 5. escalation・飽和・天井の正直さ（空回り防止）
- escalation ladder を**決定論の状態機械**にし、枯渇軸の再試行を機構が禁止（台帳と突合）。
- ladder 完全枯渇 ＋ 制約下の到達天井 < frontier が証拠付きで確認されたら **mode:maintain＋compute 再配分**。
  「伸びない対象に枠と計算を注ぎ続けない」も恒久対策。
- **健全性指標 = 「CV↑×public非矛盾の候補が出ているか（＝汎化証拠）」**。提出数や public スコアを成果にしない。

## 6. 敵対的レビュー（本設計自体の限界・明示）
1. **common-mode**: CV と public が同じ分布シフトを共有すると揃って private を外す。三角測量は独立誤差にのみ有効
   → **hedge が必須**（§2）。
2. **public 予算/分散**: 疎に使うほど情報は少ない。反復照合は過学習 → 疎・最終照合のみ（§2）。
3. **agent/RL 型**: CV が private を代表しない → §4 で退避。
4. **自作 proxy の gaming**: ループは一致規則も回避し得る（両 proxy に効くが private に無効な共通ズレ）→ 複数CV
   スキーム・leak-free 強制・per-entity 無退行で proxy 整合性を担保。
5. **観測不能性**: private は競技中測れない以上、**いかなる対策も private 改善を保証しない**。本設計の本質は
   「最適化を強める」ではなく**認識論的謙抑＋頑健性（CV一次・public反証・hedge・型/天井の正直さ）**。

## 7. 実装状態（本設計への対応）
- 済: 提出枠効率化(reserve/spacing/改善ゲート)・公開ノート供給＋過学習フラグ(PR#404-409)。
- 本PR: 昇格ゲートを**二信号一致**へ・外部知識の**4役割**を本文へ・`cv_representative` 型フラグ導入。
- 追って: transfer-trust の決定論算出、escalation 状態機械化、健全性メトリクスの自動通報。

**要旨: private は観測不能。CV を private 代理の一次に、public を独立反証器に、両者一致だけ昇格し、
残余不確実性は構造独立 hedge で守る。外部知識は仮説源として同ゲートを通し、high-public 単独では昇格させない。**
