import fs from 'node:fs';
import { validatePtcgEnvironmentObservation } from './lib/ptcgAgentCore.js';
import { comparePtcgSearchBackends, type PtcgSearchBackendId } from './lib/ptcgSearch.js';

const [fixtureFile, backend = 'all', seedText = '0', simulationsText = '64'] =
  process.argv.slice(2);

if (!fixtureFile) {
  console.error(
    'usage: tsx src/ptcg-search-benchmark-cli.ts <fixture.json> [all|mcts|alphazero|rule-based|hybrid] [seed] [simulations]'
  );
  process.exit(1);
}

const observation = validatePtcgEnvironmentObservation(
  JSON.parse(fs.readFileSync(fixtureFile, 'utf8'))
);
const seed = Number(seedText);
const simulations = Number(simulationsText);
if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(simulations) || simulations <= 0) {
  console.error('seed and simulations must be safe integers; simulations must be positive');
  process.exit(1);
}
const supported = ['mcts', 'alphazero', 'rule-based', 'hybrid'] as const;
if (backend !== 'all' && !supported.includes(backend as (typeof supported)[number])) {
  console.error(`unknown backend: ${backend}`);
  process.exit(1);
}
const ids = backend === 'all' ? undefined : ([backend] as PtcgSearchBackendId[]);
const startedAt = process.hrtime.bigint();
const results = comparePtcgSearchBackends(observation, { seed, simulations }, ids);
const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
console.log(
  JSON.stringify({ fixture: fixtureFile, seed, simulations, elapsedMs, results }, null, 2)
);
