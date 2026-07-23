# League KPI baseline — run `baseline`

- KPI: cross-agent round-robin (総当たり), per-agent aggregate win rate over the pool (Wilson 95% CI)
- Deck: `01` (mirror mode — both seats same deck, isolates agent skill)
- N per pairing: 6 (seat-alternating) — **screen-N**
- Total faults: **0**

## Payoff matrix — row agent's win rate vs column agent (decided games)

| vs | matsu | take | ume | zero |
| --- | ---: | ---: | ---: | ---: |
| **matsu** | — | 0.667 | 0.833 | 1.000 |
| **take** | 0.333 | — | 1.000 | 0.833 |
| **ume** | 0.167 | 0.000 | — | 0.667 |
| **zero** | 0.000 | 0.167 | 0.333 | — |

## Per-agent league KPI (aggregate over pool)

| rank | agent | pool win rate | Wilson 95% CI | decided | faults |
| ---: | --- | ---: | :---: | ---: | ---: |
| 1 | matsu | 0.833 | [0.608, 0.942] | 18 | 0 |
| 2 | take | 0.722 | [0.491, 0.875] | 18 | 0 |
| 3 | ume | 0.278 | [0.125, 0.509] | 18 | 0 |
| 4 | zero | 0.167 | [0.058, 0.392] | 18 | 0 |
