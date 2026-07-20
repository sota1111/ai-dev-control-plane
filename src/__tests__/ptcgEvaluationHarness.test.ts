import {
  EVALUATION_PROTOCOL_VERSION,
  buildEvaluationPlan,
  evaluationProtocolFingerprint,
  runEvaluation,
  type EvaluationProtocol,
  type EvaluationRunner,
} from '../lib/ptcgEvaluationHarness.js';

const protocol = (): EvaluationProtocol => ({
  protocolVersion: EVALUATION_PROTOCOL_VERSION,
  environmentVersion: 'cabt-engine@abc123+rules-2026.07',
  baseSeed: 4919,
  repetitions: 2,
  decks: [
    { id: 'deck-b', contentHash: 'sha256-b' },
    { id: 'deck-a', contentHash: 'sha256-a' },
  ],
  opponentPool: [
    { snapshotId: 'model.g2', artifactId: 'gs://models/g2' },
    { snapshotId: 'model.g1', artifactId: 'gs://models/g1' },
  ],
  methods: [
    { id: 'mcts', artifactId: 'git:mcts@222' },
    { id: 'policy', artifactId: 'git:policy@111' },
  ],
});

const deterministicRunner: EvaluationRunner = async (match) => ({
  winner: (match.seed + match.orientation) % 3 === 0 ? 'method' : 'opponent',
  turns: (match.seed % 20) + 1,
});

describe('fair evaluation harness', () => {
  it('fixes and records deck, seed, opponent pool, and both seat orientations', () => {
    const plan = buildEvaluationPlan(protocol());
    expect(plan).toHaveLength(2 * 2 * 2 * 2 * 2);
    const comparable = plan.filter(
      (match) =>
        match.deckId === 'deck-a' &&
        match.opponentSnapshotId === 'model.g1' &&
        match.repetition === 0
    );
    expect(comparable).toHaveLength(4);
    expect(new Set(comparable.map((match) => match.methodId))).toEqual(new Set(['mcts', 'policy']));
    expect(new Set(comparable.map((match) => match.seed)).size).toBe(1);
    for (const method of ['mcts', 'policy']) {
      const pair = comparable.filter((match) => match.methodId === method);
      expect(pair.map((match) => [match.seat0, match.seat1])).toEqual([
        ['method', 'opponent'],
        ['opponent', 'method'],
      ]);
    }
    expect(comparable[0]).toMatchObject({
      deckHash: 'sha256-a',
      opponentArtifactId: 'gs://models/g1',
    });
  });

  it('re-runs byte-identically for fixed conditions and seed', async () => {
    const runners = { mcts: deterministicRunner, policy: deterministicRunner };
    const first = await runEvaluation(protocol(), runners);
    const second = await runEvaluation(protocol(), runners);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.protocolFingerprint).toBe(evaluationProtocolFingerprint(first.protocol));
    expect(first.protocol).toMatchObject({
      protocolVersion: EVALUATION_PROTOCOL_VERSION,
      environmentVersion: 'cabt-engine@abc123+rules-2026.07',
    });
  });

  it('uses the identical common interface for different methods', async () => {
    const seen: Record<string, string[]> = { mcts: [], policy: [] };
    const runner =
      (id: string): EvaluationRunner =>
      async (match) => {
        seen[id].push(
          `${match.deckId}:${match.opponentSnapshotId}:${match.seed}:${match.orientation}`
        );
        return { winner: 'draw', metadata: { implementation: id } };
      };
    const result = await runEvaluation(protocol(), {
      mcts: runner('mcts'),
      policy: runner('policy'),
    });
    expect(seen.mcts).toEqual(seen.policy);
    expect(result.results.filter((row) => row.methodId === 'mcts')).toHaveLength(16);
    expect(result.results.filter((row) => row.methodId === 'policy')).toHaveLength(16);
  });

  it('makes protocol changes visible in the fingerprint and rejects incomplete pools', () => {
    const changed = protocol();
    changed.baseSeed += 1;
    expect(evaluationProtocolFingerprint(changed)).not.toBe(
      evaluationProtocolFingerprint(protocol())
    );
    const invalid = protocol();
    invalid.opponentPool = [];
    expect(() => buildEvaluationPlan(invalid)).toThrow('opponentPool must not be empty');
  });
});
