# 6. ケーススタディ: ROGII 事後分析

`rogii-wellbore-geology-prediction`（RMSE, lower better, 締切 2026-08-05）。
public 銅圏に届きながら private で圏外に沈んだ、**public 過学習の教科書事例**。この playbook の全原則の出所。

## 結果

- 最終選抜2本（ともに public 銅圏 ≤6.400）:
  - w0.40: public **6.395** → private **9.285**
  - w0.50: public 6.403 → private **9.372**
- private rank **3436 / 6125 = top 56%**（中央値 8.002 より下）。
- private 銅ボーダー **6.397**（public 6.400 とほぼ不変）＝**LB 全体は動かず、我々のパイプラインだけ +2.9ft 崩壊**。

## 全提出の public→private（gap 一様 +2.9, 順位相関 r=0.948）

| submission | public | private | gap |
|---|---|---|---|
| full pipeline w0.60（初手） | 6.477 | 9.461 | +2.98 |
| blend w0.40（選抜） | 6.395 | 9.285 | +2.89 |
| blend w0.55 | 6.497 | 9.427 | +2.93 |
| blend w0.80 | 6.652 | 9.715 | +3.06 |
| PF fallback | 8.752 | 11.184 | +2.43 |
| contact-override | 44.456 | 30.383 | **−14.07**（唯一の負 gap） |

- gap は**初手 full-pipeline から +2.9 焼き込まれていた**。後半のブレンド掃引は 2.9 ズレた曲線上を
  滑っただけ（順位は保存 r=0.948 だが**水準が全部間違っていた**）。
- contact-override 単体だけ gap が逆符号＝**較正層が split 間で挙動激変**する証拠。

## 核心の敗因

1. **正しい信号を捨てた**: `champion.json` の leak-free toe-holdout（screen 8.297 / confirm 11.225）は
   **private 9.285 をほぼ的中**させていた。public 6.4 こそ外れ値。だが全昇格/選抜を public LB で判断し、
   local を「heuristic proxy」と格下げして無視した。
2. **public 特化の過学習層**: gold-prefix 較正 + contact-override + self-verified-anchor が public の
   坑井構造を舐めていた。参照NB 公称 public 7.872 を我々 port が 6.477 と 1.4ft 上回った時点で赤信号
   だったが「改善」と誤認。
3. **選抜2本が両方 public 最良**（分散ゼロ）。
4. **メダル指令を public ノイズ追いに翻訳**（現実から 2.9 離れた数字を 0.08 詰めた）。
5. **無情報 proxy での誤結論**: cycle11 が可視 CSV byte 比較から「blend inert」を2度誤判定
   （contact-override が可視坑井を全被覆するため。実際は hidden で lever は生きていた）。

## 2位（AnchorCNN）との対比 — 同じ状況、逆の規律で勝った

2位のコンペは **public↔private 順位 τ=−1.00（完全逆転）/ OOF↔private τ=+0.80**。

| 2位 提出 | OOF | public | private |
|---|---|---|---|
| sub068 | 5.624 | **5.780** | 6.126 |
| sub076（**最終選抜**） | **5.140** | 6.146 | **5.802** ← 2位 |

- sub076 は public が068より**悪い**のに private 最良。**public 最良で選べば2位を逃していた。**
- 彼は **OOF を信じて選んで勝った**。我々は同じ道具(toe-holdout)を持ちながら public を信じて負けた。
- 技術面でも 2位は正しかった: GR マッチは多峰 → **点推定はモード平均で構造的に敗北**。条件付き分布
  P(dTVT|TVT) + DP 期待値デコードが正解（詳細 [問題の定式化](03-problem-formulation.md)）。
- メタ: 2位は **Claude Code Agent + 人間**。検証設計・恒等式発見・sub-column 洞察は人間が担った。

## この事例が生んだ恒久ルール
→ [検証編 P1-P5](01-validation-and-selection.md) / [ガードレール G1-G4](05-autonomous-cycle-guardrails.md) /
[Code ランタイム C1-C4](02-code-competition-runtime.md)。

## 一次資料
- 2位 writeup: Bilzard "2nd Place Solution: AnchorCNN — Conditional Probabilistic Path Modeling"（2026-08-07）
- memory: `rogii-2nd-place-anchorcnn-study`, `rogii-final-submission-w030-perwell-adaptive`,
  `rogii-2nd-place`（study）, `sot2459-rogii-cycle12-converge-terminal-blend-inert`
- failure-log: `docs/ai/failure-log.md`（2026-08-06 エントリ）
- 実験台帳: `<rogii-claude repo>/docs/ai/experiment_ledger.jsonl`（POST-MORTEM エントリ）
