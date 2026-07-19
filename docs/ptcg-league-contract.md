# PTCG common league contract

`src/lib/ptcgLeagueContract.ts` is the adapter boundary for registering agents and decks and for
exchanging one match per JSONL line. The contract versions are `ptcg-league-registry/v1` and
`ptcg-league-match/v1`.

## Registry

Agents, decks, and submissions have separate, globally unique lowercase IDs. A submission is the
immutable pairing of one agent version and one deck version. Thus 松・竹・梅・Zero can all use the
same deck without conflating agent identity with deck identity.

```json
{
  "schemaVersion": "ptcg-league-registry/v1",
  "agents": [{ "id": "agent.matsu", "name": "松", "version": "git:abc123" }],
  "decks": [{ "id": "deck.01", "name": "Deck 01", "contentHash": "sha256:<64 lowercase hex>", "version": "2026-07" }],
  "submissions": [{ "id": "submission.matsu.01", "agentId": "agent.matsu", "deckId": "deck.01", "version": "1" }]
}
```

IDs are stable keys; display names may change. `contentHash` pins deck bytes, while each `version`
pins the producing component. Registries reject duplicate IDs and dangling submission references.

## Match JSONL

Each UTF-8 line is one `LeagueMatchRecord`. Required fields are `matchId`, non-negative integer
`seed`, explicit `first`/`second` submission IDs, outcome, nullable structured fault, per-seat and
total latency in milliseconds, and registry/engine/adapter versions. `total` must be at least the two
recorded per-seat latencies. Blank lines are ignored.

```json
{"schemaVersion":"ptcg-league-match/v1","matchId":"match.round1.0001","seed":1747,"seats":{"first":{"submissionId":"submission.matsu.01"},"second":{"submissionId":"submission.zero.01"}},"result":{"outcome":"first","fault":null},"latencyMs":{"first":10,"second":12,"total":25},"versions":{"registry":"2026-07","engine":"cabt-1","adapter":"fixture-1"}}
```

Adapter usage:

```ts
const registryErrors = validateRegistry(candidateRegistry);
const line = encodeMatchRecord(record);       // validates, emits exactly one trailing newline
const records = parseMatchJsonl(text, registry); // validates references and reports line numbers
```

CLI validation:

```bash
npx tsx src/ptcg-league-contract-cli.ts validate-registry registry.json
npx tsx src/ptcg-league-contract-cli.ts validate-jsonl matches.jsonl registry.json
```

Writers must preserve the schema fields and bump the schema version for breaking changes. Readers may
store additional transport metadata outside the record, but must not infer agent or deck identity from
the submission ID; always resolve it through the registry.
