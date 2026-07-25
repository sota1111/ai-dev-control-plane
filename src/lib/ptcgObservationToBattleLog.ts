import {
  BATTLE_LOG_SCHEMA_VERSION,
  type BattleLogEvent,
  type BattleLogV1,
  type BoardState,
  type CardState,
  type PlayerBoardState,
  replayBattleLog,
} from './ptcgBattleLogReplay.js';

/**
 * Adapter: cabt-engine board capture -> `ptcg-battle-log/v1` (SOT-1906 contract).
 *
 * The capture (produced by `scripts/ptcg_capture_battle.py`) records the public
 * board of both players at every engine decision. This module maps that stream
 * into the nine-event replay contract consumed by the SOT-1907 timeline viewer.
 *
 * Fidelity boundary: the reconstructed board (which Pokemon are in play, their
 * HP/damage, attached-energy count, prizes remaining, deck count, knockouts,
 * turn progression, and the winner) mirrors the real match. Hand-pile size and
 * discard-pile contents follow the contract's event model rather than every
 * hidden card movement, because v1 has no event for trainer/energy plays out of
 * hand. Every produced log is validated with `replayBattleLog` before return.
 */

export interface CaptureCard {
  serial: number;
  cardId: number;
  hp: number;
  maxHp: number;
  energyCount: number;
  toolCount: number;
}

export interface CapturePlayerBoard {
  active: CaptureCard[];
  bench: CaptureCard[];
  deckCount: number;
  handCount: number;
  prizeCount: number;
  discardCount: number;
}

export interface CaptureFrame {
  turn: number;
  yourIndex: number;
  firstPlayer: number;
  result: number;
  players: CapturePlayerBoard[];
}

export interface BattleCapture {
  captureVersion: string;
  seed: number;
  players: Record<string, string>;
  outcome: string;
  winnerSeat: number | null;
  fault: unknown;
  decisions: number;
  frames: CaptureFrame[];
}

export interface ConvertOptions {
  battleId?: string;
  /** Display names per seat index; defaults to the capture's own player labels. */
  playerNames?: [string, string];
}

const STANDARD_PRIZES = 6;
const ENERGY_TOKEN = 'energy';

function cardId(playerName: string, serial: number): string {
  return `${playerName}-s${serial}`;
}

function toCardState(playerName: string, card: CaptureCard): CardState {
  return {
    id: cardId(playerName, card.serial),
    name: `card-${card.cardId}`,
    maxHp: card.maxHp,
    damage: Math.max(0, card.maxHp - card.hp),
    energy: Array.from({ length: Math.max(0, card.energyCount) }, () => ENERGY_TOKEN),
  };
}

function inPlay(board: CapturePlayerBoard): Array<{ card: CaptureCard; active: boolean }> {
  return [
    ...board.active.map((card) => ({ card, active: true })),
    ...board.bench.map((card) => ({ card, active: false })),
  ];
}

/** Mutable per-player model kept in lock-step with what `replayBattleLog` computes. */
interface ModelBoard {
  state: PlayerBoardState;
  /** serial -> the CardState object currently in `state` (active or bench). */
  cards: Map<number, CardState>;
  realDeck: number;
  realPrize: number;
}

function emptyPlayerState(deckCount: number, handCount: number, discardCount: number): PlayerBoardState {
  return {
    active: null,
    bench: [],
    deckCount,
    handCount,
    discard: Array.from({ length: Math.max(0, discardCount) }, (_unused, index) => `setup-discard-${index}`),
    prizesRemaining: STANDARD_PRIZES,
  };
}

export function convertCaptureToBattleLog(
  capture: BattleCapture,
  options: ConvertOptions = {}
): BattleLogV1 {
  if (!capture || !Array.isArray(capture.frames) || capture.frames.length === 0) {
    throw new Error('capture must contain at least one frame');
  }
  const names: [string, string] = options.playerNames ?? [
    capture.players?.['0'] ?? 'player-0',
    capture.players?.['1'] ?? 'player-1',
  ];
  if (names[0] === names[1]) {
    names[1] = `${names[1]}-2`;
  }
  const battleId = options.battleId ?? `${names[0]}-vs-${names[1]}-seed${capture.seed}`;

  const frames = capture.frames;
  // Baseline = first frame where both players have their six prizes set; before
  // that is engine setup (deck<->prize shuffling) that the contract cannot model.
  let baseline = frames.findIndex(
    (frame) =>
      (frame.players[0]?.prizeCount ?? 0) >= STANDARD_PRIZES &&
      (frame.players[1]?.prizeCount ?? 0) >= STANDARD_PRIZES
  );
  if (baseline < 0) baseline = Math.min(1, frames.length - 1);

  const first = frames[baseline];
  const firstPlayerSeat = first.firstPlayer >= 0 ? first.firstPlayer : 0;

  const events: BattleLogEvent[] = [];
  const models: ModelBoard[] = [0, 1].map((seat) => {
    const board = first.players[seat];
    const played = inPlay(board).length;
    // Seed the hand so opening plays return it to the real observed hand size.
    const state = emptyPlayerState(board.deckCount, board.handCount + played, board.discardCount);
    return { state, cards: new Map(), realDeck: board.deckCount, realPrize: STANDARD_PRIZES };
  });

  const currentPlayerRef = { value: names[firstPlayerSeat] };

  const initialState: BoardState = {
    turn: 1,
    currentPlayer: currentPlayerRef.value,
    players: {
      [names[0]]: structuredClone(models[0].state),
      [names[1]]: structuredClone(models[1].state),
    },
    winner: null,
  };

  const emit = (event: BattleLogEvent): void => {
    events.push(event);
  };

  const ensureHand = (seat: number): void => {
    const model = models[seat];
    if (model.state.handCount < 1 && model.state.deckCount >= 1) {
      emit({ type: 'draw', player: names[seat], count: 1 });
      model.state.deckCount -= 1;
      model.state.handCount += 1;
      model.realDeck -= 1;
    }
  };

  const playCard = (seat: number, capCard: CaptureCard, active: boolean): void => {
    ensureHand(seat);
    if (model_handEmpty(models[seat])) return; // no deck and no hand: cannot represent
    const model = models[seat];
    const card = toCardState(names[seat], capCard);
    if (active) {
      if (model.state.active) {
        // Active occupied without a preceding knockout (retreat/promote): fall
        // back to bench to keep the log valid.
        if (model.state.bench.length >= 5) return;
        emit({ type: 'play-bench', player: names[seat], card });
        model.state.bench.push(structuredClone(card));
        model.cards.set(capCard.serial, model.state.bench[model.state.bench.length - 1]);
      } else {
        emit({ type: 'play-active', player: names[seat], card });
        model.state.active = structuredClone(card);
        model.cards.set(capCard.serial, model.state.active);
      }
    } else {
      if (model.state.bench.length >= 5) return;
      emit({ type: 'play-bench', player: names[seat], card });
      model.state.bench.push(structuredClone(card));
      model.cards.set(capCard.serial, model.state.bench[model.state.bench.length - 1]);
    }
    model.state.handCount -= 1;
  };

  const knockout = (seat: number, serial: number): void => {
    const model = models[seat];
    const card = model.cards.get(serial);
    if (!card) return;
    if (card.damage < card.maxHp) {
      emit({ type: 'damage', player: names[seat], targetId: card.id, amount: card.maxHp - card.damage });
      card.damage = card.maxHp;
    }
    emit({ type: 'knockout', player: names[seat], targetId: card.id });
    if (model.state.active?.id === card.id) model.state.active = null;
    else model.state.bench = model.state.bench.filter((entry: CardState) => entry.id !== card.id);
    model.state.discard.push(card.id, ...card.energy);
    model.cards.delete(serial);
  };

  // Opening board: place whatever Pokemon are already in play at the baseline.
  for (const seat of [0, 1]) {
    for (const { card, active } of inPlay(first.players[seat])) {
      playCard(seat, card, active);
    }
  }

  let engineTurn = first.turn;
  for (let i = baseline + 1; i < frames.length; i += 1) {
    const frame = frames[i];
    for (const seat of [0, 1]) {
      const model = models[seat];
      const board = frame.players[seat];
      const curBySerial = new Map<number, { card: CaptureCard; active: boolean }>();
      for (const entry of inPlay(board)) curBySerial.set(entry.card.serial, entry);

      // 1. Knockouts: serials that left the board.
      for (const serial of [...model.cards.keys()]) {
        if (!curBySerial.has(serial)) knockout(seat, serial);
      }
      // 2. Draws: real deck decreases map to draw (deck -> hand).
      const deckDelta = model.realDeck - board.deckCount;
      if (deckDelta > 0 && deckDelta <= model.state.deckCount) {
        emit({ type: 'draw', player: names[seat], count: deckDelta });
        model.state.deckCount -= deckDelta;
        model.state.handCount += deckDelta;
      }
      model.realDeck = board.deckCount;
      // 3. New Pokemon entering play.
      for (const { card, active } of inPlay(board)) {
        if (!model.cards.has(card.serial)) playCard(seat, card, active);
      }
      // 4/5. Energy attachments and damage on cards present in both.
      for (const [serial, entry] of curBySerial) {
        const card = model.cards.get(serial);
        if (!card) continue;
        const addedEnergy = entry.card.energyCount - card.energy.length;
        for (let e = 0; e < addedEnergy; e += 1) {
          emit({ type: 'attach-energy', player: names[seat], targetId: card.id, energy: ENERGY_TOKEN });
          card.energy.push(ENERGY_TOKEN);
        }
        const curDamage = Math.max(0, entry.card.maxHp - entry.card.hp);
        if (curDamage > card.damage) {
          emit({ type: 'damage', player: names[seat], targetId: card.id, amount: curDamage - card.damage });
          card.damage = curDamage;
        }
      }
      // 6. Prizes taken.
      const prizeDelta = model.realPrize - board.prizeCount;
      if (prizeDelta > 0 && prizeDelta <= model.state.prizesRemaining) {
        emit({ type: 'take-prize', player: names[seat], count: prizeDelta });
        model.state.prizesRemaining -= prizeDelta;
        model.state.handCount += prizeDelta;
      }
      model.realPrize = board.prizeCount;
    }
    // Turn progression: alternate the active player each engine-turn increment.
    if (frame.turn > engineTurn) {
      const next = currentPlayerRef.value === names[0] ? names[1] : names[0];
      emit({ type: 'end-turn', nextPlayer: next });
      currentPlayerRef.value = next;
      engineTurn = frame.turn;
    }
  }

  if (capture.winnerSeat === 0 || capture.winnerSeat === 1) {
    emit({ type: 'declare-winner', player: names[capture.winnerSeat] });
  }

  const log: BattleLogV1 = {
    schemaVersion: BATTLE_LOG_SCHEMA_VERSION,
    battleId,
    initialState,
    events,
  };
  // Self-validate: throws BattleLogReplayError if any event violates the contract.
  replayBattleLog(log);
  return log;
}

function model_handEmpty(model: ModelBoard): boolean {
  return model.state.handCount < 1;
}
