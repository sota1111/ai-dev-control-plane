# Synthetic league calibration against real runtime

- Training seeds: 186700, 186701
- Holdout seeds: 186702 (never used to fit agent bias)
- Model: ridge-agent-bias, ridge=12

## Calibration metrics

| split | metric | before | after |
| --- | --- | ---: | ---: |
| training | MAE | 0.228571 | 0.14619 |
| training | max absolute difference | 0.675 | 0.54 |
| training | ranking agreement | 0.5 | 0.888889 |
| holdout | MAE | 0.295833 | 0.294583 |
| holdout | max absolute difference | 0.65 | 0.5125 |
| holdout | ranking agreement | 0.764706 | 0.647059 |

Holdout calibration result: **PASS**

## Matchup error hypotheses

| matchup | n | runtime | synthetic | calibrated | abs error before → after | hypothesis |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| debate vs sol | 4 | 0.75 | 0.075 | 0.21 | 0.675 → 0.54 | debate is systematically stronger in real runtime than synthetic evaluation predicts |
| matsu vs ume | 4 | 0.75 | 0.3 | 0.6 | 0.45 → 0.15 | matsu is systematically stronger in real runtime than synthetic evaluation predicts |
| sol vs ume | 4 | 0.75 | 0.35 | 0.5025 | 0.4 → 0.2475 | sol is systematically stronger in real runtime than synthetic evaluation predicts |
| ume vs zero | 4 | 0.5 | 0.875 | 0.66 | 0.375 → 0.16 | zero is systematically stronger in real runtime than synthetic evaluation predicts |
| debate vs ume | 4 | 0.75 | 0.4 | 0.6875 | 0.35 → 0.0625 | debate is systematically stronger in real runtime than synthetic evaluation predicts |
| take vs zero | 4 | 1 | 0.675 | 0.745 | 0.325 → 0.255 | take is systematically stronger in real runtime than synthetic evaluation predicts |
| sol vs take | 4 | 0.5 | 0.8 | 0.6675 | 0.3 → 0.1675 | take is systematically stronger in real runtime than synthetic evaluation predicts |
| take vs ume | 4 | 0.75 | 0.45 | 0.735 | 0.3 → 0.015 | take is systematically stronger in real runtime than synthetic evaluation predicts |
| sol vs zero | 4 | 0.75 | 0.55 | 0.4875 | 0.2 → 0.2625 | zero is systematically stronger in real runtime than synthetic evaluation predicts |
| fable vs matsu | 4 | 0.25 | 0.45 | 0.345 | 0.2 → 0.095 | matsu is systematically stronger in real runtime than synthetic evaluation predicts |
| fable vs zero | 4 | 0.75 | 0.95 | 0.93 | 0.2 → 0.18 | agent-level bias is small; matchup interaction or runtime sampling is the leading hypothesis |
| fable vs ume | 4 | 0.5 | 0.325 | 0.52 | 0.175 → 0.02 | fable is systematically stronger in real runtime than synthetic evaluation predicts |
| matsu vs take | 4 | 0.5 | 0.325 | 0.34 | 0.175 → 0.16 | agent-level bias is small; matchup interaction or runtime sampling is the leading hypothesis |
| matsu vs sol | 4 | 0.5 | 0.35 | 0.4975 | 0.15 → 0.0025 | matsu is systematically stronger in real runtime than synthetic evaluation predicts |
| matsu vs zero | 4 | 0.5 | 0.625 | 0.71 | 0.125 → 0.21 | matsu is systematically stronger in real runtime than synthetic evaluation predicts |
| debate vs matsu | 4 | 0.25 | 0.35 | 0.3375 | 0.1 → 0.0875 | agent-level bias is small; matchup interaction or runtime sampling is the leading hypothesis |
| debate vs take | 4 | 0.5 | 0.6 | 0.6025 | 0.1 → 0.1025 | agent-level bias is small; matchup interaction or runtime sampling is the leading hypothesis |
| debate vs fable | 4 | 0.25 | 0.325 | 0.4175 | 0.075 → 0.1675 | debate is systematically stronger in real runtime than synthetic evaluation predicts |
| debate vs zero | 4 | 0.5 | 0.425 | 0.4975 | 0.075 → 0.0025 | debate is systematically stronger in real runtime than synthetic evaluation predicts |
| fable vs take | 4 | 0.5 | 0.45 | 0.36 | 0.05 → 0.14 | take is systematically stronger in real runtime than synthetic evaluation predicts |
| fable vs sol | 4 | 0.25 | 0.25 | 0.2925 | 0 → 0.0425 | fable is systematically stronger in real runtime than synthetic evaluation predicts |

## Reinforcement priority

Most negative remaining runtime-minus-calibrated score is the first reinforcement target.

| rank | agent | runtime score | calibrated score | remaining gap |
| ---: | --- | ---: | ---: | ---: |
| 1 | ume | 0.347222 | 0.435833 | -0.088611 |
| 2 | zero | 0.319444 | 0.328333 | -0.008889 |
| 3 | debate | 0.458333 | 0.45875 | -0.000417 |
| 4 | sol | 0.611111 | 0.609583 | 0.001528 |
| 5 | fable | 0.513889 | 0.505 | 0.008889 |
| 6 | take | 0.597222 | 0.585 | 0.012222 |
| 7 | matsu | 0.652778 | 0.5775 | 0.075278 |

## Reproduction

```bash
npx tsx src/ptcg-synthetic-calibration-cli.ts
```
