import {
  LEAGUE_MATCH_SCHEMA,
  LEAGUE_REGISTRY_SCHEMA,
  encodeMatchRecord,
  parseMatchJsonl,
  validateMatchRecord,
  validateRegistry,
  type LeagueMatchRecord,
  type LeagueRegistry,
} from '../lib/ptcgLeagueContract.js';

const hash = `sha256:${'a'.repeat(64)}`;
const registry: LeagueRegistry = {
  schemaVersion: LEAGUE_REGISTRY_SCHEMA,
  agents: ['matsu', 'take', 'ume', 'zero'].map((id) => ({
    id: `agent.${id}`,
    name: id,
    version: 'git:abc',
  })),
  decks: [{ id: 'deck.01', name: 'Deck 01', contentHash: hash, version: '2026-07' }],
  submissions: ['matsu', 'take', 'ume', 'zero'].map((id) => ({
    id: `submission.${id}.01`,
    agentId: `agent.${id}`,
    deckId: 'deck.01',
    version: '1',
  })),
};
const record: LeagueMatchRecord = {
  schemaVersion: LEAGUE_MATCH_SCHEMA,
  matchId: 'match.round1.0001',
  seed: 1747,
  seats: {
    first: { submissionId: 'submission.matsu.01' },
    second: { submissionId: 'submission.zero.01' },
  },
  result: { outcome: 'first', fault: null },
  latencyMs: { first: 10, second: 12, total: 25 },
  versions: { registry: '2026-07', engine: 'cabt-1', adapter: 'fixture-1' },
};

describe('PTCG league contract', () => {
  it('registers 松竹梅Zero independently from deck and submission ids', () => {
    expect(validateRegistry(registry)).toEqual([]);
    expect(
      new Set([...registry.agents, ...registry.decks, ...registry.submissions].map((x) => x.id))
        .size
    ).toBe(9);
  });

  it('rejects duplicate ids and broken references', () => {
    const invalid = structuredClone(registry);
    invalid.decks[0].id = 'agent.matsu';
    invalid.submissions[0].deckId = 'deck.missing';
    expect(validateRegistry(invalid)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('duplicates registry id'),
        expect.stringContaining('must reference a deck'),
      ])
    );
  });

  it('validates match input/result/fault/latency/seed/version', () => {
    expect(validateMatchRecord(record, registry)).toEqual([]);
    const invalid = structuredClone(record);
    invalid.seed = -1;
    invalid.result.fault = { seat: 'second', kind: 'timeout', code: '' };
    invalid.latencyMs.total = 1;
    expect(validateMatchRecord(invalid, registry)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('seed'),
        expect.stringContaining('fault.code'),
        expect.stringContaining('total'),
      ])
    );
  });

  it('round-trips fixture JSONL byte-for-byte deterministically', () => {
    const jsonl = encodeMatchRecord(record);
    const decoded = parseMatchJsonl(jsonl, registry);
    expect(decoded).toEqual([record]);
    expect(decoded.map(encodeMatchRecord).join('')).toBe(jsonl);
  });

  it('reports the failing JSONL line', () => {
    expect(() => parseMatchJsonl(`${encodeMatchRecord(record)}{bad}\n`, registry)).toThrow(
      'line 2'
    );
  });
});
