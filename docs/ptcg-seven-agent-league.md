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
