# Producing viewer-readable battle logs from a real match (SOT-1909)

The SOT-1907 board timeline viewer (and the SOT-1906 replay contract in
`src/lib/ptcgBattleLogReplay.ts`) consume a single `ptcg-battle-log/v1` JSON.
Aggregate match reports (winner / decision count / think time) do **not** carry
board state and cannot be shown in the viewer. This pipeline runs a real match,
captures the engine board at every decision, and converts it into a
viewer-readable `ptcg-battle-log/v1` file.

## 1. Capture a real match

`scripts/ptcg_capture_battle.py` drives the native cabt engine boundary with two
real submission processes (the same mechanism as
`scripts/ptcg_real_runtime_match.py`) and additionally records the public board
of both players at every decision.

```bash
TAKE=.targets/ptcg-agent-take          # engine + one agent (has cg/ and venv)
OBO=/path/to/ptcg-agent-obo            # other agent (main.py + deck.csv)

$TAKE/venv/bin/python scripts/ptcg_capture_battle.py \
  --engine-repo "$TAKE" \
  --server scripts/ptcg_agent_runtime_server.py \
  --first-id take  --first-repo "$TAKE" \
  --second-id obo  --second-repo "$OBO" \
  --seed 190901 \
  --out capture.json
```

The output is a `ptcg-battle-capture/v1` file: per-decision frames of
`{turn, yourIndex, firstPlayer, result, players[]}`, where each player board
records `active`/`bench` cards (`serial`, `cardId`, `hp`, `maxHp`, `energyCount`)
plus `deckCount`, `handCount`, `prizeCount`, and `discardCount`. Only public
state is captured — hidden hand contents are never recorded.

## 2. Convert to the viewer contract

```bash
npx tsx src/ptcg-battle-log-from-capture-cli.ts capture.json out.battle-log.json \
  --battle-id take-vs-obo-seed190901 --names take,obo
```

`src/lib/ptcgObservationToBattleLog.ts` maps the board stream into the nine-event
contract by diffing consecutive frames (new Pokemon → `play-active`/`play-bench`;
energy count up → `attach-energy`; HP down → `damage`; a card leaving the board →
`damage`-to-lethal + `knockout`; prize down → `take-prize`; deck down → `draw`;
engine-turn increment → `end-turn`; final result → `declare-winner`). Every log
is validated with `replayBattleLog` before it is written, so a written file is
guaranteed to open in the viewer.

## 3. Open it in the viewer

```bash
npx tsx src/ptcg-battle-viewer-cli.ts out.battle-log.json          # browser
# or open ios/PTCGBattleViewer in Xcode and load the JSON.
```

## Fidelity boundary

Faithful to the real match: which Pokemon are in play, their HP / accumulated
damage, attached-energy count, prizes remaining, deck count, knockouts, turn
progression, and the winner. Modeled by the contract (not frame-exact): hand-pile
size and discard-pile contents, because `ptcg-battle-log/v1` has no event for
trainer/energy cards played out of hand, and retreat/promote/heal have no event.
These approximations never affect the board reconstruction the viewer displays.

Representative real conversions live under `artifacts/sot-1909-viewer/`.
