# Cross-agent league KPI gate (SOT-1896)

Common promotion gate for the PTCG agents (matsu / take / ume / zero / fable). This **replaces the
self-mirror KPI** — "candidate vs its own champion mirror win rate, Wilson 95% CI lower bound > 0.5" —
which has **saturated**: recent improvement candidates (SOT-1853/1854/1855/1878/1883/1884/1885/1886) were
almost all rejected by the mirror gate, yet the Kaggle score order shows a large real spread
(take 575.5 > matsu 557.2 > zero 451.7 ≧ ume 444.9; fable 596.2). The mirror KPI stopped measuring the
thing Kaggle rewards: performance against a **diverse pool of other agents**.

## The gate

**KPI = cross-agent round-robin (総当たり).** Every champion plays every other champion. Each agent's
league KPI is its **aggregate win rate over the whole opponent pool**, with a Wilson 95% CI. The CI
**lower bound** is the decision metric.

**Two-stage, unchanged in spirit (screen → confirm):**

1. **screen (small N)** — cheap round-robin to cut clearly-worse candidates.
2. **confirm (large N)** — decisive round-robin; only its CI is trusted for promotion.

**Promotion rule.** A candidate replaces the incumbent champion only when **all** hold:

- `candidate.pool_ci_lower > champion.pool_ci_lower` over the **same** opponent pool (the candidate must
  beat the pool by a margin the CI can see — not merely beat its own mirror), **and**
- `candidate.faults == 0` (no illegal action / timeout / dead subprocess; faults are never folded into
  wins), **and**
- latency within budget (the per-player think-time allowance already enforced by the driver).

Otherwise the incumbent champion is kept (behaviour reverted; a non-promotion is still recorded).

**Opponent pool.** The 5 shipped champions are the canonical pool; semantic variants may be added as
extra pool members. If the league order **diverges** from the Kaggle order, adjust the pool composition
(add/relabel opponents, or rotate the deck set) and record the rationale here — do **not** silently keep
a pool that mis-ranks the field.

## One-command reproduction

From the control-plane repo (schedules the champion pairings, runs the real `cg`-engine matches via the
existing driver, and writes the payoff matrix + per-agent pool CI):

```sh
# defaults: champions "matsu take ume zero", deck 01 (mirror), N=6 (screen), run-id "baseline"
scripts/ai/league_kpi_gate.sh
# confirm run (larger N), custom pool/deck:
N=40 DECK=01 RUN_ID=confirm scripts/ai/league_kpi_gate.sh --champions "matsu take ume zero"
```

It is **resumable**: each pairing is written atomically, so re-invoking with the same `RUN_ID` skips
completed pairings. Artifacts land in `artifacts/league-kpi/<run-id>/` (`report.json`,
`payoff_matrix.md`, `shards/<a>_vs_<b>.json`, `driver.log`).

Match play reuses `ptcg-agent-matsu/eval/battle_matsu_take_ume.py` (each project's actual Kaggle
`main.agent` in an isolated subprocess on the real `cg` engine), so the **same command reproduces the
gate from any repo** that has the engine + sibling checkouts:

```sh
# equivalent full round-robin directly from a repo that hosts the engine + siblings:
cd /workspaces/ptcg-agent-matsu && venv/bin/python eval/battle_matsu_take_ume.py --n 40 \
    --decks-dir decks/initial --deck-mode mirror --seed 20260723 --json /tmp/league.json
```

> The `cg` engine exposes **no shuffle-seed API** (documented in SOT-1858): results are **statistical**
> (Wilson CI), not bit-reproducible. Reproducibility is of the *manifest* (champions, deck, N,
> provenance) and CIs tighten with N — "more matches, not a fixed seed" is how confirm is made decisive.

## Baseline (screen-N) — measured this run

Real matches, `cg` engine, deck `01` (dragapult) mirror, **N=6 per pairing (18 decided games/agent),
fault 0**. Full machine-readable data in `artifacts/league-kpi/baseline/`.

Payoff matrix — row agent's win rate vs column agent (decided games):

| vs | matsu | take | ume | zero |
| --- | ---: | ---: | ---: | ---: |
| **matsu** | — | 0.667 | 0.833 | 1.000 |
| **take** | 0.333 | — | 1.000 | 0.833 |
| **ume** | 0.167 | 0.000 | — | 0.667 |
| **zero** | 0.000 | 0.167 | 0.333 | — |

Per-agent league KPI (aggregate over pool):

| rank | agent | pool win rate | Wilson 95% CI | decided | faults |
| ---: | --- | ---: | :---: | ---: | ---: |
| 1 | matsu | 0.833 | [0.608, 0.942] | 18 | 0 |
| 2 | take | 0.722 | [0.491, 0.875] | 18 | 0 |
| 3 | ume | 0.278 | [0.125, 0.509] | 18 | 0 |
| 4 | zero | 0.167 | [0.058, 0.392] | 18 | 0 |

**fable is not in this baseline**: it (and `sol`) currently fail to start under the driver — the
sandboxed `main.py` resolves `from agents import GreedyAgent, ...` to `/kaggle_simulations/agent/agents/`
(a module-name collision), which fable/sol's package layout does not export. matsu/take/ume/zero run
clean. Wiring fable/sol into this driver is a tracked follow-up (below). fable's real competitiveness is
independently attested by SOT-1858 (`sol` vs `fable` = 50%, an even match — the strongest sol-resistance
after ume/debate) and its Kaggle-topping 596.2.

## League KPI vs Kaggle order — consistency

| tier | league (this run) | Kaggle score |
| --- | --- | --- |
| strong | matsu 0.833, take 0.722 | take 575.5, matsu 557.2 (fable 596.2) |
| weak | ume 0.278, zero 0.167 | zero 451.7, ume 444.9 |

- **Tier separation is exact**: the league cleanly splits {matsu, take} (strong) from {ume, zero} (weak),
  matching Kaggle. This is precisely what the saturated self-mirror KPI failed to show.
- **Intra-tier order is within noise**: league says matsu > take and ume > zero; Kaggle says the reverse
  in both pairs — but the league CIs overlap heavily ([0.608, 0.942] vs [0.491, 0.875]; [0.125, 0.509] vs
  [0.058, 0.392]) and the Kaggle gaps (557↔575, 445↔452) are inside the observed ±20-point submission
  noise. No intra-tier claim is statistically supported at screen-N; a confirm run (large N, ideally a
  deck rotation rather than the single deck 01) is needed to order within a tier.
- **Pool sensitivity (rationale for the pool design):** SOT-1858's *sol-centric star* ranked ume as the
  strongest sol-resister, which contradicts ume's weak standing in the champion round-robin. That gap is
  exactly the pool-composition effect the gate warns about: a single-opponent (star) pool mis-ranks the
  field, whereas the **full champion round-robin tracks the Kaggle tiers**. Hence the canonical gate is
  the round-robin over all champions, not a star against any one reference agent.

## Per-repo adoption

Each agent repo's promotion decision should read the league KPI instead of its self-mirror gate:

- **matsu** — `docs/KPI.md`, `eval/champion_league.py` (opponent currently restricted to
  `champion`/`history/*`): widen to the champion pool and apply the pool-CI-lower rule above.
- **take** — `docs/KPI.md`; `eval/runtime_league.py` already cross-plays (sol/debate/fable/zero) — point
  the gate at its aggregate CI.
- **ume** — `docs/KPI.md` ("昇格ゲートの主指標"); `eval/bench_runtime_crossplay.py` subprocess pattern.
- **zero** — `docs/evaluation/*promotion.json`; already round-robins vs semantic opponents — swap those
  for the champion pool.
- **fable** — no agent-promotion gate today (deck round-robin only); adopt the league KPI once it runs
  under the driver.

The gate command is repo-agnostic (it hosts the engine from matsu and drives every sibling), so "1
command per repo" is the single `battle_matsu_take_ume.py` / `league_kpi_gate.sh` invocation above.

## Follow-ups (explicitly out of this session)

1. **fable/sol driver fix** — resolve the `agents` module-name collision so all 5 champions (+sol) run in
   one round-robin; then re-measure the full 5×5 payoff matrix.
2. **confirm run (large N)** — decisive round-robin with a deck rotation (not just deck 01) to order
   within tiers; a long real run is beyond a single non-background session.
3. **per-repo wiring** — edit each repo's `KPI.md` / gate script to the pool-CI-lower rule and append the
   baseline to each `eval/kpi_history.jsonl`.
