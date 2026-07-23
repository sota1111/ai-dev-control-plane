# Seven-agent PTCG league interface

`src/lib/ptcgSevenAgentLeague.ts` connects Sol, Debate, Fable, Matsu, Take, Ume, and Zero to one
`start → action → end` lifecycle. Every boundary returns the same structured fault vocabulary:
`timeout`, `illegal-action`, `crash`, or `adapter`.

`resolveSevenAgentManifest(siblingsRoot, engineCommit)` is the reproducibility gate. It refuses missing
repositories, entrypoints, or decks and requires full 40-character engine and repository commit SHAs.
The resulting `ptcg-seven-agent-league/v1` manifest pins agent, deck, model, and config provenance; deck
bytes additionally carry SHA-256. A repository with no separate model/config file records a null path
but still pins that logical artifact to the repository commit.

All repositories must be sibling checkouts named `ptcg-agent-{sol,debate,fable,matsu,take,ume,zero}`
and expose `main.py` plus `deck.csv`. To reproduce a run, checkout each manifest commit, verify the deck
SHA-256, checkout the engine commit, construct `CommonLeagueAdapter` runtimes, then use only its three
lifecycle methods. `smokeSevenAgentAdapters` exercises the common engine-facing boundary for all seven;
production runtimes remain responsible for translating each repository's native process protocol.

## Real-process audit

`src/ptcg-real-runtime-league-cli.ts` closes that boundary by running every unordered pair through the
real cabt engine while loading each repository's `main.py` in an isolated Python process. A fixed agent
seed is passed as both `AGENT_SEED` and `PYTHONHASHSEED`, and every seed is run in both seat orders.

The versioned `config/ptcg_real_runtime_league.json` manifest pins the fixed seed set, seat reversal,
timeout, eight-hour budget, estimated match cost, and representative matchups. The planner schedules
one seed across every matchup before using later seeds, and places configured priority matchups first
within each seed. Budget truncation always keeps both seat orientations together.

```bash
npx tsx src/ptcg-real-runtime-league-cli.ts \
  --plan config/ptcg_real_runtime_league.json \
  --output artifacts/ptcg-league/sot-1880-runtime
```

The output directory contains the pinned manifest, an atomic per-match `checkpoint.json`, the normal
league report, and `runtime-audit.{json,md}`. Re-running the same command resumes completed matches
without duplication. The audit compares every representative real-runtime matchup with the synthetic
SOT-1847 profile, identifies the largest absolute win-rate gap, and reports each matchup's sample size,
runtime Wilson 95% interval, and a Newcombe-style interval for the runtime/synthetic difference. It
separately counts process faults, unfinished games, illegal actions, and timeouts. The command fails if
its configured eight-hour budget is exceeded.
