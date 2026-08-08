# 5. 自律サイクルのガードレール

我々の Kaggle 改善サイクルは**完全自動**（cron→起案→worker→提出）。その構造が生んだ失敗と対策。

## G0. メタ教訓 — 全自動は「検証設計」を人間に委ねられず詰む
ROGII 2位（Bilzard）は **Claude Code Agent + 人間**で戦い、著者はこう書いた:

> 「今の"autonomous"エージェントは自律的でなく、**人間の伴走が必要**。でないと初歩問題で詰まる」
> 「Claude は大量にアイデアを出すが質は**かなりランダム**に感じた」

- MD-phase TTA は Claude が提案（26位の別チームにも同じ提案）だが、「sub-column 幅に」「8位相 sweep」の
  **判断は人間**。Claude のレパートリーに良案はあるが、**勝敗を分けたのは人間の検証設計・問題定式化**。
- 我々の全自動 rogii は、まさにこの層（「public を信じるな」「metric の裾を見ろ」「点推定を疑え」）を
  欠いて top56%。→ **自律サイクルに人間の検証設計レビュー点を1つ挟む**（下記 G4）。

## G1. 一次KPI を「public LB 順位」にしない
- 現行 design（§42-51）は**LB 順位を primary KPI** に置く。これは hidden private split で
  **public 過学習を制度的に誘発する**（サイクルが public を最適化してしまう）。
- 対策: **昇格ゲートの一次条件を leak-free CV（＋頑健受容テスト）**にし、public は二次 sanity にする。
  [検証編](01-validation-and-selection.md) の P1-P5 を promote 判定に組み込む。

## G2. 「メダル指令」を public ノイズ追いに翻訳しない
- 人間の「メダル圏内まで継続」は、**「銅ボーダーまで public を 0.003 詰める」ではない**。
- 正しい翻訳: **「local↔public の gap を閉じる」**。gap こそが汎化リスクそのもの。
  ROGII では現実(private 9.3)から 2.9ft 離れた public を 6.477→6.395 と 0.08 詰めて最終2日を浪費した。
- cutoff まで 0.003 は **LB ノイズ**で目標にならない。ボーダー付近の微差は追わない。

## G3. 収束モードと探索モードの誤用に注意
- 「残レバーは内部ブレンドのみ」と判断して1定数 sweep を繰り返すのは、**public を最適化対象にした
  選択過学習**になりやすい。レバーが尽きたら、**新しい定式化**（[問題の立て方](03-problem-formulation.md)）を
  疑う方が、既存パイプラインの微調整より価値が高い。
- レバーの生死は **hidden LB スコア差**で判定（可視 byte 比較で CLOSE しない、[C3](02-code-competition-runtime.md)）。

## G4. 締切・大勝負イシューに人間チェックポイントを1つ挟む
- メダルが懸かる／締切当日の最終選抜は、**提出前に人間へ1コメント**:
  「CV最良は X、public最良は Y、両者乖離 Z。最終2枠は CV最良+hedge を選ぶ」と明示して**選択の分散を確認**。
- Linear の Requirement Clarification（CLAUDE.md）に準拠。安全側デフォルトは「CV最良を1枠確保」。

## G5. 実験台帳に hypothesis / evidence / result を必ず残す
- `<repo>/docs/ai/experiment_ledger.jsonl` に promoted/rejected/inconclusive を根拠付きで記録。
- **rejected の理由**が次サイクルの設計を決める（2位も「効かなかった設計分岐」を明記）。
- inconclusive を「実LB で未確認」のまま champion にしない（proxy 非信頼、[検証編 P2](01-validation-and-selection.md)）。

## チェックリスト（サイクル運用）
- [ ] 昇格の一次ゲートは CV（＋頑健受容テスト）、public は二次
- [ ] メダル指令＝「gap を閉じる」に翻訳、ボーダー微差を追わない
- [ ] レバー生死は hidden LB 差で判定
- [ ] 締切/メダル勝負は提出前に人間チェックポイント1つ
- [ ] 台帳に hypothesis/evidence/result（特に rejected 理由）
