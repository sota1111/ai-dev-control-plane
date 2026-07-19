import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from './lib/ptcgBattleLab.js';
import {
  currentAgentAdapters,
  runBaselineLeague,
  writeBaselineArtifact,
  type AgentRequest,
} from './lib/ptcgBaselineLeague.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const runId = args.get('--run-id') ?? 'baseline-smoke';
const output =
  args.get('--output') ?? path.join(root, 'artifacts', 'ptcg-baseline', `${runId}.json`);
const seeds = (args.get('--seeds') ?? '1750,1751').split(',').map(Number);

function stableScore(agentId: string, request: AgentRequest): number {
  return Number.parseInt(sha256Hex(`${agentId}:${request.deckId}:${request.seed}`).slice(0, 8), 16);
}

const adapters = currentAgentAdapters(async (agentId, request) => ({
  score: stableScore(agentId, request),
  latencyMs: 1 + (stableScore(agentId, request) % 7),
  fallback: false,
}));
const artifact = await runBaselineLeague({
  adapters,
  decks: [
    {
      id: 'deck.baseline',
      name: 'Baseline deck',
      contentHash: `sha256:${sha256Hex('baseline-deck-v1')}`,
      version: 'baseline-v1',
    },
  ],
  config: {
    runId,
    generatedAt: '2026-07-19T00:00:00.000Z',
    seeds,
    engineVersion: 'deterministic-smoke/v1',
    registryVersion: 'baseline-2026-07',
  },
});
writeBaselineArtifact(output, artifact);
console.log(
  `baseline ${runId}: matches=${artifact.kpi.matches} faults=${artifact.kpi.faults} fallbacks=${artifact.kpi.fallbacks}`
);
console.log(`payoff cells=${artifact.payoff.length} output=${path.relative(root, output)}`);
