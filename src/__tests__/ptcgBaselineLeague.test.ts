import {
  buildBaselineRegistry,
  currentAgentAdapters,
  runBaselineLeague,
  type AgentRequest,
} from '../lib/ptcgBaselineLeague.js';

const deck = {
  id: 'deck.test',
  name: 'Test deck',
  contentHash: `sha256:${'a'.repeat(64)}`,
  version: '1',
};

function score(agentId: string, request: AgentRequest): number {
  return ['matsu', 'take', 'ume', 'zero'].indexOf(agentId) * 100 + request.seed;
}

describe('current four-agent baseline league', () => {
  it('adapts 松竹梅Zero entrypoints to one launch contract', async () => {
    const calls: string[] = [];
    const adapters = currentAgentAdapters(async (id, request) => {
      calls.push(`${id}:${request.seat}:${request.seed}`);
      return { score: score(id, request), latencyMs: 2, fallback: false };
    });
    expect(adapters.map((a) => a.name)).toEqual(['松', '竹', '梅', 'Zero']);
    expect(adapters.every((a) => a.entrypoint.length > 0)).toBe(true);
    const registry = buildBaselineRegistry(adapters, [deck]);
    expect(registry.submissions).toHaveLength(4);
    await adapters[0].invoke({
      matchId: 'match.test',
      seed: 1,
      seat: 'first',
      deckId: deck.id,
      opponentSubmissionId: 'submission.zero.test',
    });
    expect(calls).toEqual(['matsu:first:1']);
  });

  it('runs a deterministic seat-swapped league and emits payoff/KPIs', async () => {
    const adapters = currentAgentAdapters(async (id, request) => ({
      score: score(id, request),
      latencyMs: request.seat === 'first' ? 2 : 3,
      fallback: id === 'matsu' && request.seed === 11,
    }));
    const artifact = await runBaselineLeague({
      adapters,
      decks: [deck],
      config: {
        runId: 'test',
        generatedAt: '2026-07-19T00:00:00Z',
        seeds: [11, 22],
        engineVersion: 'fixture/v1',
        registryVersion: 'test/v1',
      },
    });
    expect(artifact.matches).toHaveLength(24);
    expect(artifact.payoff).toHaveLength(12);
    expect(artifact.matches.every((m) => [11, 22].includes(m.seed))).toBe(true);
    expect(
      new Set(
        artifact.matches.map((m) => `${m.seats.first.submissionId}:${m.seats.second.submissionId}`)
      ).size
    ).toBe(12);
    expect(artifact.matches.every((m) => m.latencyMs.total === 5)).toBe(true);
    expect(artifact.kpi).toEqual({
      matches: 24,
      faults: 0,
      fallbacks: 6,
      latencyMs: { average: 5, max: 5 },
    });
    expect(
      artifact.payoff.every((cell) => cell.matches === 4 && cell.ciLow >= 0 && cell.ciHigh <= 1)
    ).toBe(true);
  });

  it('records adapter faults without losing the expected result count', async () => {
    const adapters = currentAgentAdapters(async (id, request) => ({
      score: score(id, request),
      latencyMs: 1,
      fallback: false,
      fault: id === 'zero' ? { kind: 'adapter', code: 'ZERO_FIXTURE_FAULT' } : undefined,
    }));
    const artifact = await runBaselineLeague({
      adapters,
      decks: [deck],
      config: {
        runId: 'fault',
        generatedAt: '2026-07-19T00:00:00Z',
        seeds: [1],
        engineVersion: 'fixture/v1',
        registryVersion: 'test/v1',
      },
    });
    expect(artifact.kpi.matches).toBe(12);
    expect(artifact.kpi.faults).toBe(6);
    expect(
      artifact.matches.filter((m) => m.result.fault?.code === 'ZERO_FIXTURE_FAULT')
    ).toHaveLength(6);
  });
});
