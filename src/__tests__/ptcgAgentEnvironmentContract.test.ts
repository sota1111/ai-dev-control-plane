import {
  roundTripPtcgEnvironmentObservation,
  validatePtcgAgentConfig,
  validatePtcgEnvironmentObservation,
  type PtcgEnvironmentObservation,
} from '../lib/ptcgAgentCore.js';
import {
  ptcgAgentContractFixtures,
  type PtcgAgentContractFixture,
} from '../testing/ptcgAgentContractFixtures.js';

function runEnvironmentContract(fixture: PtcgAgentContractFixture): void {
  describe(`${fixture.agentId} environment contract`, () => {
    it('uses a valid current configuration for the same adapter', () => {
      expect(validatePtcgAgentConfig(fixture.createConfig()).agent.id).toBe(fixture.agentId);
    });
    it('round-trips the observation without changing its meaning', () => {
      const observation = fixture.createObservation();
      expect(roundTripPtcgEnvironmentObservation(observation)).toEqual(observation);
    });

    it('keeps legal action enumeration and mask identical', () => {
      const observation = validatePtcgEnvironmentObservation(fixture.createObservation());
      expect(
        observation.actionSpace
          .filter((_, index) => observation.legalActionMask[index])
          .map((action) => action.id)
      ).toEqual(observation.legalActionIds);
    });

    it('exposes only the acting seat hand and the opponent hand count', () => {
      const serialized = JSON.stringify(
        validatePtcgEnvironmentObservation(fixture.createObservation())
      );
      expect(serialized).toContain(`${fixture.agentId}-own-card`);
      expect(serialized).not.toMatch(/"(?:opponentHand|opponentDeck|hiddenCards)"/);
      expect(fixture.createObservation().publicState.opponentHandCount).toBe(6);
    });
  });
}

describe('松・竹・梅・zero cross-agent environment contract', () => {
  expect(ptcgAgentContractFixtures.map(({ agentId }) => agentId)).toEqual([
    'matsu',
    'take',
    'ume',
    'zero',
  ]);
  ptcgAgentContractFixtures.forEach(runEnvironmentContract);

  it('rejects a schema version mismatch explicitly', () => {
    const candidate = {
      ...ptcgAgentContractFixtures[0].createObservation(),
      schemaVersion: 'ptcg-environment/v2',
    };
    expect(() => validatePtcgEnvironmentObservation(candidate)).toThrow(
      'observation schemaVersion must be ptcg-environment/v1'
    );
  });

  it.each(['opponentHand', 'opponentDeck', 'hiddenCards'])(
    'rejects leaked private field %s',
    (field) => {
      const observation = ptcgAgentContractFixtures[0].createObservation();
      const candidate = {
        ...observation,
        publicState: { ...observation.publicState, [field]: ['secret-card'] },
      } as PtcgEnvironmentObservation;
      expect(() => validatePtcgEnvironmentObservation(candidate)).toThrow('unknown fields');
    }
  );

  it('rejects disagreement between legal actions and the mask', () => {
    const candidate = ptcgAgentContractFixtures[0].createObservation();
    candidate.legalActionMask = [true, true, true];
    expect(() => validatePtcgEnvironmentObservation(candidate)).toThrow(
      'legalActionIds must exactly match legalActionMask'
    );
  });
});
