# SOT-2213 PTCG定期提出計画の限界評価

結論は **条件付き継続**。各lineageの2枠目は、同じUTC日に未提出のartifact SHA-256で、
かつ既存の評価・提出互換性gateを通過したcandidateに限る。同一artifactの再提出は、5枠/dayの
20%を消費する一方でartifact単位の情報利得が0なので停止する。

機械可読の全結果は
`artifacts/ptcg-submission-plan/sot-2213/evaluation.json` に保存した。

## 根拠

- GPT retained champion: 69–51、57.5%、Wilson 95% CI 48.56–65.98%、seat gap 41.67pt。
- Claude retained champion: 88–66、57.14%、Wilson 95% CI 49.25–64.69%、seat gap 31.17pt。
- 両系統とも最新探索で昇格candidateなし。現在の提出archive fingerprintは系統ごとに不変。
- live Kaggle APIではGPT ref `55091718` は561.9。archive summaryの600.0は誤記。
- 同一championの自動提出スコア標準偏差はGPT 12.67、Claude 46.89。package差分がない状態でも
  public scoreが大きく動くため、直近低下はartifact劣化より評価分散で説明される。

## 情報価値とコスト

| 計画 | slots/day | unique fingerprints | 2枠目の追加観測 | duplicate率 |
| --- | ---: | ---: | ---: | ---: |
| 現行（同一artifactを2回） | 4 | 2 | 0 | 50% |
| 独立検証済みcandidateを2回目に使用 | 4 | 4 | 2 | 0% |

実装はPTCGに `repeat_requires_new_artifact` を有効化し、提出messageへSHA-256を記録する。
過去提出にfingerprintが無く新規性を証明できない場合もfail closedでskipする。
