# PTCG battle-log replay contract

`src/lib/ptcgBattleLogReplay.ts` defines the stable boundary between a battle engine log and consumers
such as a timeline viewer. The current and only accepted schema version is `ptcg-battle-log/v1`.

## Input

A log contains:

- `schemaVersion`: exactly `ptcg-battle-log/v1`;
- `battleId`: a non-empty stable identifier;
- `initialState`: turn, current player, winner, and a player-keyed board;
- `events`: an ordered list of state transitions.

Each player board contains `active`, `bench` (maximum five), `deckCount`, `handCount`, `discard`, and
`prizesRemaining`. Each in-play card contains a stable `id`, display `name`, `maxHp`, accumulated
`damage`, and attached `energy`.

Supported events are `draw`, `play-active`, `play-bench`, `attach-energy`, `damage`, `knockout`,
`take-prize`, `end-turn`, and `declare-winner`. Producers must preserve engine order and use distinct
card ids for cards simultaneously in play.

## Output and errors

`replayBattleLog(input)` returns snapshot 0 for the initial state, followed by one deep-copied snapshot
after each event. Replaying the same JSON produces the same state sequence and never mutates the input
or earlier snapshots.

Malformed state, unknown players/cards, invalid transitions, unsupported versions, and unsupported
events throw `BattleLogReplayError`. Event failures include the zero-based source index, for example:
`event[3]: damage amount must be positive`. This is the diagnostic contract for adapters and UI.

Representative normal and invalid logs live under `src/__tests__/fixtures/`; their tests are in
`src/__tests__/ptcgBattleLogReplay.test.ts`.
