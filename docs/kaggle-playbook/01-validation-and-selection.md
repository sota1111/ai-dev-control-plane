# 1. 検証とサブミッション選択（最重要）

> **一言**: hidden private split のコンペで信じるべき一次KPIは **public LB ではなく leak-free CV**。
> public は二次的な sanity check にすぎない。両者が食い違ったら **CV を信じる**。

## なぜこれが最重要か（rogii の実証）

| | public | private | 意味 |
|---|---|---|---|
| 我々 best | 6.395 | **9.285** (top56%) | public を信じ、+2.9ft の過学習に気づけず沈没 |
| 我々 leak-free CV | — | (toe-holdout 8.3/11.2) | **private 9.3 をほぼ的中させていた**のに無視した |
| 2位 最終選抜 | 6.146 | **5.802** (2位) | public は他提出より悪いが OOF 最良 → 選んで勝った |

2位のコンペでは **public↔private の順位相関が τ=−1.00（完全逆転）**、**OOF↔private が τ=+0.80**。
つまり **public 最良で選ぶと必ず負ける市場**だった。彼は OOF を信じて勝ち、我々は public を信じて負けた。
**同じ道具（OOF/CV）を持ちながら、規律だけが違った。**

## 原則

### P1. leak-free な検証を最初に作る（コードより先）
- **エンティティ単位で hold out**する。行単位の CV は同一エンティティ（坑井・ユーザー・系列）の
  情報が train/val に跨ってリークし、楽観的になる。ROGII なら「坑井まるごと」、時系列なら「未来区間」。
- 「同一IDの train コピー」が test にある場合、それは**可視プレースホルダ**で hidden には無いことが多い。
  そこに合わせ込む層（contact-override 等）は **CV でも hidden でも無力**（[ケース参照](06-case-rogii-postmortem.md)）。

### P2. CV が LB と同じオーダーかを確認する
- CV と public が**桁・数単位でズレる**なら、まず**リークか CV 設計ミスを疑う**。public を信じてはいけない。
- 我々の toe-holdout(8-11) は private(9.3) と同オーダーで**正しかった**。ズレていたのは public(6.4) の方。
  「local が悲観的すぎる」ではなく「public が楽観的すぎる（過学習）」が正しい解釈だった。

### P3. metric の裾を診断する
- pooled RMSE・対数損失・SSE 系は**少数の破滅ケースに支配される**（ROGII: train773/private148 の小標本）。
  「平均が良い」は少数ケースの運かもしれない。
- **頑健受容テスト（leave-largest-contribution-out）** — 2位が実際に使った手法:
  1. base vs treat で per-エンティティの損失差 `g_w = loss_treat(w) − loss_base(w)` を計算。
  2. `|g_w|` 降順にエンティティを除去し、改善が消える除去数 `k*` を求める。
  3. `k*` が **public LB サイズ未満**（＝少数の運で改善が消える）なら**却下**。
  4. `k*` が public LB サイズを超えて生き残る改善だけを**採用**。
- これを昇格ゲート（実験台帳の promote 判定）に組み込む。

#### 参照実装 `scripts/ai/robust_acceptance.py`（SOT-2515）

頑健受容テストを control-plane の**参照実装**として提供する。stdlib のみ・決定論・exec互換（`__file__`
非依存）で、target repo からパス指定で呼べる。

```bash
# base/treat の per-entity 損失 CSV（ヘッダ entity,loss）を渡す。
# lower-is-better(RMSE/SSE) が既定。higher-is-better は --higher-better。
python3 /path/to/control-plane/scripts/ai/robust_acceptance.py \
    --base per_entity_loss_base.csv \
    --treat per_entity_loss_treat.csv \
    --public-size 148          # public LB のエンティティ数
# stdout: 機械可読 JSON（k_star / removal_curve / judgement …）
# stderr: 人間可読サマリ
# exit  : 0=accept（改善 かつ k* > public-size） / 1=reject / 2=データ・使用法エラー
```

- 除去順は「改善への寄与が大きいエンティティ順」（genuine な改善では `|g_w|` 最大順に一致し、
  除去カーブが単調になるので `k*` が一意に定まる）。
- `--public-size` を省くと判定せず report のみ（exit 0）。
- 出力の `k_star` を実験台帳の `k_star` フィールドへ記録する（[台帳スキーマ](../kaggle-improvement-cycle.md#実験台帳スキーマsot-2515)）。

### P4. 最終提出枠は分散させる
- Kaggle は最終2枠を選べる。**片方は CV 最良（頑健）、もう片方は攻めた hedge** にする。
- **両方 public 最良を選ぶのは最悪手**（我々がやった。両方 private 9.3 だった）。
- 2位も `sub076`(final, CV最良) + `sub077`(hedge) の2本構成だった。

### P5. 「参照NBの public を上回った」を警戒する
- 公開NB/参照実装を「移植」して public を大きく上回ったら、**その上振れは後付け較正の過学習を疑う**。
  忠実な移植は元スコア近傍に着地するはず。ROGII では参照公称 public 7.872 を我々 port が 6.477 と
  1.4ft 上回った＝赤信号だったが「改善」と誤認した。
- 上振れ分は必ず **CV で裏取り**してから採用する。

## アンチパターン（やってはいけない）
- ❌ public LB を最適化対象にして、1定数だけ違う提出を何本も投げて best public を選ぶ（＝選択による過学習）。
- ❌ CV が無い／リークしている状態で public を唯一の信号にする。
- ❌ CV と public の乖離を「CV が悲観的」と解釈して public を採用する。
- ❌ 最終2枠を both public-best にする。
