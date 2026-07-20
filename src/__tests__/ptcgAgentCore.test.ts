import {
  PTCG_AGENT_CONFIG_DEFAULTS,
  encodePtcgAgentConfig,
  migratePtcgAgentConfig,
  parsePtcgAgentConfig,
  type PtcgAgentAdapter,
  type PtcgAgentCoreConfig,
} from '../lib/ptcgAgentCore.js';

const current: PtcgAgentCoreConfig = {
  schemaVersion: 'ptcg-agent-core/v2',
  agent: { id: 'matsu', entrypoint: 'main.agent' },
  runtime: { seed: 1765, timeoutMs: 10_000, maxRetries: 1 },
  compatibility: { adapterApi: 'ptcg-agent-adapter/v1' },
};

describe('PTCG agent core configuration', () => {
  it('round-trips the current schema canonically', () => {
    const encoded = encodePtcgAgentConfig(current);
    expect(encoded.endsWith('\n')).toBe(true);
    expect(parsePtcgAgentConfig(encoded)).toEqual(current);
    expect(encodePtcgAgentConfig(parsePtcgAgentConfig(encoded))).toBe(encoded);
  });

  it('migrates supported v1 configuration and applies defaults', () => {
    expect(
      migratePtcgAgentConfig({
        schemaVersion: 'ptcg-agent-core/v1',
        agentId: 'zero',
        entrypoint: 'ptcg_agent_zero.submission.agent',
      })
    ).toEqual({
      schemaVersion: 'ptcg-agent-core/v2',
      agent: { id: 'zero', entrypoint: 'ptcg_agent_zero.submission.agent' },
      runtime: PTCG_AGENT_CONFIG_DEFAULTS,
      compatibility: { adapterApi: 'ptcg-agent-adapter/v1' },
    });
  });

  it.each([
    [{ ...current, schemaVersion: 'ptcg-agent-core/v99' }, 'unsupported config schemaVersion'],
    [{ ...current, extra: true }, 'unknown fields'],
    [{ ...current, runtime: { ...current.runtime, timeoutMs: 0 } }, 'greater than zero'],
    [{ ...current, agent: { ...current.agent, id: 'pine' } }, 'one of matsu'],
  ])('rejects invalid configuration %#', (candidate, message) => {
    expect(() => migratePtcgAgentConfig(candidate)).toThrow(message);
  });
});

function fixture(
  id: PtcgAgentAdapter['id'],
  displayName: PtcgAgentAdapter['displayName']
): PtcgAgentAdapter {
  return {
    apiVersion: 'ptcg-agent-adapter/v1',
    id,
    displayName,
    implementationVersion: 'fixture/v1',
    async initialize() {},
    async invoke(request) {
      return { score: request.seed, latencyMs: 1, fallback: false };
    },
    async close() {},
  };
}

describe('four-agent adapter contract', () => {
  it('is implemented by 松・竹・梅・zero fixtures through one interface', async () => {
    const adapters: PtcgAgentAdapter[] = [
      fixture('matsu', '松'),
      fixture('take', '竹'),
      fixture('ume', '梅'),
      fixture('zero', 'Zero'),
    ];
    expect(adapters.map(({ id }) => id)).toEqual(['matsu', 'take', 'ume', 'zero']);
    for (const adapter of adapters) {
      await adapter.initialize({ ...current, agent: { ...current.agent, id: adapter.id } });
      await expect(
        adapter.invoke({
          matchId: 'match.fixture',
          seed: 1765,
          seat: 'first',
          deckId: 'deck.fixture',
          opponentSubmissionId: 'submission.fixture',
        })
      ).resolves.toMatchObject({ score: 1765, fallback: false });
      await adapter.close();
    }
  });
});
