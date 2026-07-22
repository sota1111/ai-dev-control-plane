# 松竹梅 ensemble evaluation

SOT-1851 は Matsu / Take / Ume の各強化評価を同じ4 opponent（Sol / Debate / Fable / Zero）で統合し、profile多様性とmatchup別の非退行を判定する。

```bash
npx tsx src/ptcg-ensemble-evaluation-cli.ts
```

入力は `config/ptcg_ensemble_evaluation.json` に固定される。各agentの20 seed・先後反転済みA/B reportとcheckpointを読み、`artifacts/ptcg-ensemble/sot-1851/report.json` と `report.md` を再生成する。3 source runはいずれも8時間budget、checkpoint/resume有効である必要がある。

多様性はdeck artifact、strategy、risk profileの一意数と、risk ordinal・search depth・exploration constantを正規化したpairwise policy distanceで報告する。非退行は各opponentのensemble win rateが50%未満、または全opponent平均より15 point超低い場合を重大退行とする。加えて3 agentすべての旧版A/B deltaが正でなければFAILとする。fault、unfinished、illegal actionはいずれも0のみPASS。
