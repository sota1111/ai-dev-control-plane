import type {
  PtcgAgentId,
  PtcgAgentCoreConfig,
  PtcgEnvironmentObservation,
} from '../lib/ptcgAgentCore.js';

export interface PtcgAgentContractFixture {
  agentId: PtcgAgentId;
  createConfig(): PtcgAgentCoreConfig;
  createObservation(): PtcgEnvironmentObservation;
}

function fixture(agentId: PtcgAgentId): PtcgAgentContractFixture {
  return {
    agentId,
    createConfig: () => ({
      schemaVersion: 'ptcg-agent-core/v2',
      agent: { id: agentId, entrypoint: `${agentId}.agent` },
      runtime: { seed: 1766, timeoutMs: 10_000, maxRetries: 0 },
      compatibility: { adapterApi: 'ptcg-agent-adapter/v1' },
    }),
    createObservation: () => ({
      schemaVersion: 'ptcg-environment/v1',
      seat: 'first',
      turn: 3,
      publicState: {
        active: { first: 'pikachu', second: 'charmander' },
        prizeCount: { first: 5, second: 4 },
        opponentHandCount: 6,
      },
      privateState: { hand: [`${agentId}-own-card`], deckCount: 41 },
      actionSpace: [
        { id: 'play:0', kind: 'play-card', source: 'hand:0' },
        { id: 'attack:0', kind: 'attack', source: 'active' },
        { id: 'pass', kind: 'pass' },
      ],
      legalActionIds: ['attack:0', 'pass'],
      legalActionMask: [false, true, true],
    }),
  };
}

export const ptcgAgentContractFixtures: PtcgAgentContractFixture[] = [
  fixture('matsu'),
  fixture('take'),
  fixture('ume'),
  fixture('zero'),
];
