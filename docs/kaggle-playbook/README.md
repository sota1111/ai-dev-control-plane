# Kaggle Playbook — コンペ対策の恒久ナレッジ

Kaggle（および SIGNATE 等の外部コンペ）で**メダルを取り切る**ための対策集。運用の仕組み
（cron/起案/dispatcher）は [`../kaggle-improvement-cycle.md`](../kaggle-improvement-cycle.md) に、
ここには**「何を信じ、どう判断し、何を避けるか」という戦略・意思決定の知識**を置く。

このフォルダは失敗（rogii top56% 沈没）と一次資料（rogii 2位解法 AnchorCNN）から抽出した、
**次コンペで繰り返さないための行動原則**である。新しいコンペを始める前・提出する前に必ず読む。

## なぜ作ったか（1行）

ROGII で public 銅圏(6.395)→private 圏外(9.285, top56%)。**leak-free CV(8.3/11.2)が private(9.3)を
的中させていたのに、見栄えの良い public(6.4)を信じた過学習**が敗因。2位は同じ状況で OOF を信じて
勝った（public↔private 順位 τ=−1.00 の完全逆転市場だった）。この差＝検証規律。

## 目次

1. [検証とサブミッション選択](01-validation-and-selection.md) — **最重要**。CV を一次KPIに、public は二次。頑健受容テスト。最終2枠の選び方。
2. [Code コンペのランタイム](02-code-competition-runtime.md) — 隠しテスト再実行・可視/隠し坑井・マウントパス・exec 互換ゲート。
3. [問題の定式化](03-problem-formulation.md) — 点推定 vs 条件付き分布、多峰性、物理恒等式・合成データ。
4. [提出ツールと落とし穴](04-submission-tooling-gotchas.md) — Kaggle CLI/認証、提出マーカー、dedup、GPUセッション枠、CSV引用。
5. [自律サイクルのガードレール](05-autonomous-cycle-guardrails.md) — 人間チェックポイント、メダル指令の翻訳、public ノイズ追い禁止、昇格ゲート。
6. [ケーススタディ: ROGII 事後分析](06-case-rogii-postmortem.md) — 数字で見る敗因と、2位解法との対比。
7. [起票システム改善計画](07-drafting-system-improvement-plan.md) — **PLAN(人間レビュー待ち)**。playbook の教訓をシステム契約へ昇格させる実装計画。

## 提出前チェックリスト（毎回・全コンペ共通）

hidden private split のあるコンペでは、提出前にこれを通す:

- [ ] **leak-free な検証**があるか？（行単位でなく**エンティティ単位**で hold out。時系列は未来を hold out）
- [ ] その CV スコアは LB と**同じオーダー**か？桁/数ft ズレるなら**リークかCV設計ミスを疑う**（public を信じる前に CV を直す）
- [ ] public LB と CV が**乖離**したら、**悲観的な CV を信じる**（public は小さな hidden subset＝過学習しやすい）
- [ ] metric は**重い裾**か？（RMSE/対数系は少数の破滅ケースに支配される）→ 頑健受容テストを通したか
- [ ] 公開NB/参照実装の public を**上回った**なら、その上振れは**後付け較正の過学習を疑う**（CV で裏取り）
- [ ] 最終提出枠は **CV最良 × hedge** で**分散**したか？（全部 public 最良を選ばない）
- [ ] Code コンペなら [exec 互換ゲート](../../scripts/ai/...) と[ランタイム前提](02-code-competition-runtime.md)を通したか
- [ ] 提出には `[repo:...] [lineage:...]` マーカーを付けたか（帰属）

## 関連

- 運用: [`../kaggle-improvement-cycle.md`](../kaggle-improvement-cycle.md)（cron/起案/rotation/registry）
- 失敗ログ: [`../ai/failure-log.md`](../ai/failure-log.md)（2026-08-06 rogii エントリ）
- memory: `rogii-2nd-place-anchorcnn-study` / `rogii-final-submission-w030-perwell-adaptive` / `kaggle-exec-runtime-gate`
