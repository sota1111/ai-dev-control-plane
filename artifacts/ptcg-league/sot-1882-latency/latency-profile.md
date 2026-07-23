# Seven-agent real-runtime latency profile

- Total measured match time: 460261.404 ms
- Largest matchup contribution: debate vs sol (11.04%)

| agent | stage | samples | p50 ms | p95 ms | max ms |
| --- | --- | ---: | ---: | ---: | ---: |
| sol | processStartup | 12 | 21.631 | 31.773 | 31.773 |
| sol | request | 12 | 7169.092 | 19539.740 | 19539.740 |
| sol | inference | 12 | 7166.477 | 19533.571 | 19533.571 |
| debate | processStartup | 12 | 23.130 | 28.901 | 28.901 |
| debate | request | 12 | 6812.336 | 20557.082 | 20557.082 |
| debate | inference | 12 | 6809.961 | 20550.263 | 20550.263 |
| fable | processStartup | 12 | 22.512 | 27.165 | 27.165 |
| fable | request | 12 | 6002.468 | 22271.896 | 22271.896 |
| fable | inference | 12 | 5999.877 | 22265.623 | 22265.623 |
| matsu | processStartup | 12 | 23.586 | 30.899 | 30.899 |
| matsu | request | 12 | 7347.159 | 19203.762 | 19203.762 |
| matsu | inference | 12 | 7344.816 | 19197.765 | 19197.765 |
| take | processStartup | 12 | 41.943 | 47.505 | 47.505 |
| take | request | 12 | 2.738 | 5.308 | 5.308 |
| take | inference | 12 | 1.557 | 2.908 | 2.908 |
| ume | processStartup | 12 | 84.180 | 92.543 | 92.543 |
| ume | request | 12 | 3212.035 | 5754.456 | 5754.456 |
| ume | inference | 12 | 3210.400 | 5751.165 | 5751.165 |
| zero | processStartup | 12 | 66.264 | 104.363 | 104.363 |
| zero | request | 12 | 2.402 | 7.653 | 7.653 |
| zero | inference | 12 | 0.648 | 1.933 | 1.933 |

| matchup | total ms | league contribution |
| --- | ---: | ---: |
| debate vs sol | 50829.167 | 11.04% |
| debate vs fable | 49597.977 | 10.78% |
| fable vs ume | 45162.412 | 9.81% |
| matsu vs sol | 29468.439 | 6.40% |
| matsu vs ume | 25172.774 | 5.47% |
| fable vs zero | 22906.305 | 4.98% |
| debate vs zero | 22515.688 | 4.89% |
| debate vs take | 22160.133 | 4.81% |
| matsu vs zero | 22028.621 | 4.79% |
| matsu vs take | 21923.662 | 4.76% |
| sol vs ume | 21494.105 | 4.67% |
| debate vs matsu | 21216.632 | 4.61% |
| fable vs matsu | 20100.711 | 4.37% |
| sol vs zero | 19485.619 | 4.23% |
| fable vs sol | 17423.026 | 3.79% |
| debate vs ume | 14306.561 | 3.11% |
| sol vs take | 12757.154 | 2.77% |
| fable vs take | 7470.965 | 1.62% |
| take vs ume | 7142.734 | 1.55% |
| ume vs zero | 6802.002 | 1.48% |
| take vs zero | 296.716 | 0.06% |

| improvement candidate | expected reduction ms | expected reduction | parity condition |
| --- | ---: | ---: | --- |
| reuse-agent-processes-across-matches | 3255.046 | 0.71% | Reset and reseed both agents before every match; enable only after action/result parity passes. |
| cache-identical-observation-actions | 0.000 | 0.00% | Disabled by default; measure repeated canonical observations and require deterministic-agent parity. |
