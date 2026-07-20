import type { PtcgEnvironmentObservation } from '../lib/ptcgAgentCore.js';
import {
  ComposedPtcgReward,
  PTCG_REWARD_EVALUATION_SCHEMA_VERSION,
  PtcgRewardRegistry,
  comparePtcgRewardConfigs,
  type PtcgRewardConfig,
  type PtcgRewardFixture,
} from '../lib/ptcgReward.js';

function observation(turn: number, prizes: number): PtcgEnvironmentObservation {
  return {
    schemaVersion: 'ptcg-environment/v1',
    seat: 'first',
    turn,
    publicState: {
      active: { first: 'pikachu', second: 'charmander' },
      prizeCount: { first: prizes, second: 6 },
      opponentHandCount: 5,
    },
    privateState: { hand: ['energy'], deckCount: 40 },
    actionSpace: [{ id: 'attack', kind: 'attack' }],
    legalActionIds: ['attack'],
    legalActionMask: [true],
  };
}

const fixture: PtcgRewardFixture = {
  id: 'take-one-prize-and-win',
  transition: {
    before: observation(8, 1),
    action: { id: 'attack', kind: 'attack' },
    after: observation(9, 0),
    terminal: true,
    winner: 'first',
  },
};

const shaped: PtcgRewardConfig = {
  schemaVersion: 'ptcg-reward-config/v1',
  components: [
    { id: 'prize-progress', weight: 0.5 },
    { id: 'terminal-outcome', weight: 2, parameters: { win: 3, loss: -3 } },
    { id: 'turn-cost', weight: 0.1, parameters: { cost: -1 } },
  ],
};

describe('composable PTCG reward contract', () => {
  it('evaluates an environment-only transition deterministically', () => {
    const reward = new ComposedPtcgReward(shaped);
    expect(reward.evaluate(fixture.transition)).toEqual(reward.evaluate(fixture.transition));
    expect(reward.evaluate(fixture.transition)).toEqual({
      schemaVersion: PTCG_REWARD_EVALUATION_SCHEMA_VERSION,
      total: 6.4,
      contributions: [
        { id: 'prize-progress', raw: 1, weight: 0.5, weighted: 0.5 },
        { id: 'terminal-outcome', raw: 3, weight: 2, weighted: 6 },
        { id: 'turn-cost', raw: -1, weight: 0.1, weighted: -0.1 },
      ],
    });
  });

  it('exchanges and compares reward configurations on one common fixture', () => {
    const results = comparePtcgRewardConfigs(fixture, {
      sparse: {
        schemaVersion: 'ptcg-reward-config/v1',
        components: [{ id: 'terminal-outcome', weight: 1 }],
      },
      shaped,
    });
    expect(results.sparse.total).toBe(1);
    expect(results.shaped.total).toBe(6.4);
    expect(results.sparse.schemaVersion).toBe(results.shaped.schemaVersion);
  });

  it('supports a custom component behind the same versioned API', () => {
    const registry = new PtcgRewardRegistry().register('turn-cost', () => ({
      apiVersion: 'ptcg-reward/v1',
      id: 'turn-cost',
      evaluate: () => -4,
    }));
    const result = new ComposedPtcgReward(
      {
        schemaVersion: 'ptcg-reward-config/v1',
        components: [{ id: 'turn-cost', weight: 0.25 }],
      },
      registry
    ).evaluate(fixture.transition);
    expect(result.total).toBe(-1);
  });

  it('rejects invalid composition configuration and terminal transitions', () => {
    expect(
      () => new ComposedPtcgReward({ schemaVersion: 'ptcg-reward-config/v1', components: [] })
    ).toThrow(/at least one/);
    expect(
      () =>
        new ComposedPtcgReward({
          schemaVersion: 'ptcg-reward-config/v1',
          components: [
            { id: 'turn-cost', weight: 1 },
            { id: 'turn-cost', weight: 2 },
          ],
        })
    ).toThrow(/duplicate/);
    expect(() =>
      new ComposedPtcgReward({
        schemaVersion: 'ptcg-reward-config/v1',
        components: [{ id: 'terminal-outcome', weight: 1 }],
      }).evaluate({ ...fixture.transition, winner: undefined })
    ).toThrow(/requires winner/);
  });
});
