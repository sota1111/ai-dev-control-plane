# SOT-1848 Matsu stability A/B

Profile: `config/ptcg_matsu_stability.json`; seeds: 20; seat swap: true; games: 240.

| variant   | opponent |   W-L | win rate |  Wilson 95% |
| --------- | -------- | ----: | -------: | ----------: |
| baseline  | baseline | 17-23 |    0.425 | 0.285–0.578 |
| candidate | baseline |  33-7 |    0.825 | 0.681–0.913 |
| candidate | sol      |  32-8 |    0.800 | 0.652–0.895 |
| candidate | debate   |  34-6 |    0.850 | 0.709–0.929 |
| candidate | fable    |  34-6 |    0.850 | 0.709–0.929 |
| candidate | zero     |  38-2 |    0.950 | 0.835–0.986 |

Fault / unfinished / illegal action: 0 / 0 / 0.

The checkpoint contains every fixed-seed, seat-reversed game and may be reused to resume without duplication.
