export const BATTLE_LOG_SCHEMA_VERSION = 'ptcg-battle-log/v1' as const;

export interface AttackState {
  name: string;
  damage?: string;
  cost: string[];
}

export interface CardState {
  id: string;
  name: string;
  maxHp: number;
  damage: number;
  energy: string[];
  attacks?: Array<string | AttackState>;
  retreatCost?: string[];
}

export interface PlayerBoardState {
  active: CardState | null;
  bench: CardState[];
  deckCount: number;
  handCount: number;
  discard: string[];
  prizesRemaining: number;
}

export interface BoardState {
  turn: number;
  currentPlayer: string;
  players: Record<string, PlayerBoardState>;
  winner: string | null;
}

export type BattleLogEvent =
  | { type: 'draw'; player: string; count: number }
  | { type: 'play-active'; player: string; card: CardState }
  | { type: 'play-bench'; player: string; card: CardState }
  | { type: 'attach-energy'; player: string; targetId: string; energy: string }
  | { type: 'damage'; player: string; targetId: string; amount: number }
  | { type: 'knockout'; player: string; targetId: string }
  | { type: 'take-prize'; player: string; count: number }
  | { type: 'end-turn'; nextPlayer: string }
  | { type: 'declare-winner'; player: string };

export interface BattleLogV1 {
  schemaVersion: typeof BATTLE_LOG_SCHEMA_VERSION;
  battleId: string;
  initialState: BoardState;
  events: BattleLogEvent[];
}

export interface ReplaySnapshot {
  eventIndex: number;
  event: BattleLogEvent | null;
  state: BoardState;
}

export class BattleLogReplayError extends Error {
  constructor(
    message: string,
    readonly eventIndex: number | null = null
  ) {
    super(eventIndex === null ? message : `event[${eventIndex}]: ${message}`);
    this.name = 'BattleLogReplayError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneState(state: BoardState): BoardState {
  return structuredClone(state);
}

function assertNonNegativeInteger(
  value: unknown,
  field: string,
  eventIndex: number | null
): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new BattleLogReplayError(`${field} must be a non-negative integer`, eventIndex);
  }
}

function validateCard(
  card: unknown,
  field: string,
  eventIndex: number | null
): asserts card is CardState {
  if (
    !isRecord(card) ||
    typeof card.id !== 'string' ||
    card.id.length === 0 ||
    typeof card.name !== 'string' ||
    card.name.length === 0
  ) {
    throw new BattleLogReplayError(`${field} must contain non-empty id and name`, eventIndex);
  }
  assertNonNegativeInteger(card.maxHp, `${field}.maxHp`, eventIndex);
  if (card.maxHp === 0)
    throw new BattleLogReplayError(`${field}.maxHp must be greater than zero`, eventIndex);
  assertNonNegativeInteger(card.damage, `${field}.damage`, eventIndex);
  if (!Array.isArray(card.energy) || !card.energy.every((energy) => typeof energy === 'string')) {
    throw new BattleLogReplayError(`${field}.energy must be a string array`, eventIndex);
  }
  if (
    card.retreatCost !== undefined &&
    (!Array.isArray(card.retreatCost) ||
      !card.retreatCost.every((energy) => typeof energy === 'string'))
  ) {
    throw new BattleLogReplayError(`${field}.retreatCost must be a string array`, eventIndex);
  }
  if (card.attacks !== undefined) {
    if (!Array.isArray(card.attacks)) {
      throw new BattleLogReplayError(`${field}.attacks must be an array`, eventIndex);
    }
    for (const attack of card.attacks) {
      if (typeof attack === 'string') continue;
      if (
        !isRecord(attack) ||
        typeof attack.name !== 'string' ||
        attack.name.length === 0 ||
        (attack.damage !== undefined && typeof attack.damage !== 'string') ||
        !Array.isArray(attack.cost) ||
        !attack.cost.every((energy) => typeof energy === 'string' && energy.length > 0)
      ) {
        throw new BattleLogReplayError(
          `${field}.attacks entries must be strings or { name, damage?, cost[] }`,
          eventIndex
        );
      }
    }
  }
}

function validateInitialState(value: unknown): asserts value is BoardState {
  if (!isRecord(value)) throw new BattleLogReplayError('initialState must be an object');
  assertNonNegativeInteger(value.turn, 'initialState.turn', null);
  if (typeof value.currentPlayer !== 'string' || value.currentPlayer.length === 0) {
    throw new BattleLogReplayError('initialState.currentPlayer must be a non-empty string');
  }
  if (!isRecord(value.players) || Object.keys(value.players).length < 2) {
    throw new BattleLogReplayError('initialState.players must contain at least two players');
  }
  for (const [player, rawBoard] of Object.entries(value.players)) {
    if (!isRecord(rawBoard))
      throw new BattleLogReplayError(`initialState.players.${player} must be an object`);
    if (rawBoard.active !== null)
      validateCard(rawBoard.active, `initialState.players.${player}.active`, null);
    if (!Array.isArray(rawBoard.bench)) {
      throw new BattleLogReplayError(`initialState.players.${player}.bench must be an array`);
    }
    if (rawBoard.bench.length > 5) {
      throw new BattleLogReplayError(
        `initialState.players.${player}.bench cannot exceed five cards`
      );
    }
    rawBoard.bench.forEach((card, index) =>
      validateCard(card, `initialState.players.${player}.bench[${index}]`, null)
    );
    assertNonNegativeInteger(rawBoard.deckCount, `initialState.players.${player}.deckCount`, null);
    assertNonNegativeInteger(rawBoard.handCount, `initialState.players.${player}.handCount`, null);
    assertNonNegativeInteger(
      rawBoard.prizesRemaining,
      `initialState.players.${player}.prizesRemaining`,
      null
    );
    if (
      !Array.isArray(rawBoard.discard) ||
      !rawBoard.discard.every((card) => typeof card === 'string')
    ) {
      throw new BattleLogReplayError(
        `initialState.players.${player}.discard must be a string array`
      );
    }
  }
  if (value.winner !== null && typeof value.winner !== 'string') {
    throw new BattleLogReplayError('initialState.winner must be a player id or null');
  }
  if (!value.players[value.currentPlayer]) {
    throw new BattleLogReplayError('initialState.currentPlayer must identify a player');
  }
  if (value.winner !== null && !value.players[value.winner]) {
    throw new BattleLogReplayError('initialState.winner must identify a player or be null');
  }
}

function playerBoard(state: BoardState, player: unknown, eventIndex: number): PlayerBoardState {
  if (typeof player !== 'string' || !state.players[player]) {
    throw new BattleLogReplayError(`unknown player "${String(player)}"`, eventIndex);
  }
  return state.players[player];
}

function targetCard(board: PlayerBoardState, targetId: unknown, eventIndex: number): CardState {
  if (typeof targetId !== 'string')
    throw new BattleLogReplayError('targetId must be a string', eventIndex);
  const card =
    board.active?.id === targetId
      ? board.active
      : board.bench.find((entry) => entry.id === targetId);
  if (!card) throw new BattleLogReplayError(`target card "${targetId}" is not in play`, eventIndex);
  return card;
}

function applyEvent(state: BoardState, rawEvent: unknown, eventIndex: number): BattleLogEvent {
  if (!isRecord(rawEvent) || typeof rawEvent.type !== 'string') {
    throw new BattleLogReplayError('event must be an object with a type', eventIndex);
  }
  const event = rawEvent as unknown as BattleLogEvent;
  switch (event.type) {
    case 'draw': {
      const board = playerBoard(state, event.player, eventIndex);
      assertNonNegativeInteger(event.count, 'count', eventIndex);
      if (event.count === 0 || board.deckCount < event.count) {
        throw new BattleLogReplayError(
          'draw count must be positive and not exceed deckCount',
          eventIndex
        );
      }
      board.deckCount -= event.count;
      board.handCount += event.count;
      break;
    }
    case 'play-active': {
      const board = playerBoard(state, event.player, eventIndex);
      validateCard(event.card, 'card', eventIndex);
      if (board.active)
        throw new BattleLogReplayError('active position is already occupied', eventIndex);
      if (board.handCount === 0)
        throw new BattleLogReplayError('cannot play a card from an empty hand', eventIndex);
      board.active = structuredClone(event.card);
      board.handCount--;
      break;
    }
    case 'play-bench': {
      const board = playerBoard(state, event.player, eventIndex);
      validateCard(event.card, 'card', eventIndex);
      if (board.bench.length >= 5) throw new BattleLogReplayError('bench is full', eventIndex);
      if (board.handCount === 0)
        throw new BattleLogReplayError('cannot play a card from an empty hand', eventIndex);
      board.bench.push(structuredClone(event.card));
      board.handCount--;
      break;
    }
    case 'attach-energy':
      if (typeof event.energy !== 'string' || event.energy.length === 0) {
        throw new BattleLogReplayError('energy must be a non-empty string', eventIndex);
      }
      targetCard(
        playerBoard(state, event.player, eventIndex),
        event.targetId,
        eventIndex
      ).energy.push(event.energy);
      break;
    case 'damage': {
      const card = targetCard(
        playerBoard(state, event.player, eventIndex),
        event.targetId,
        eventIndex
      );
      assertNonNegativeInteger(event.amount, 'amount', eventIndex);
      if (event.amount === 0)
        throw new BattleLogReplayError('damage amount must be positive', eventIndex);
      card.damage += event.amount;
      break;
    }
    case 'knockout': {
      const board = playerBoard(state, event.player, eventIndex);
      const card = targetCard(board, event.targetId, eventIndex);
      if (card.damage < card.maxHp)
        throw new BattleLogReplayError('card has not received lethal damage', eventIndex);
      if (board.active?.id === card.id) board.active = null;
      else board.bench = board.bench.filter((entry) => entry.id !== card.id);
      board.discard.push(card.id, ...card.energy);
      break;
    }
    case 'take-prize': {
      const board = playerBoard(state, event.player, eventIndex);
      assertNonNegativeInteger(event.count, 'count', eventIndex);
      if (event.count === 0 || event.count > board.prizesRemaining) {
        throw new BattleLogReplayError(
          'prize count must be positive and not exceed prizesRemaining',
          eventIndex
        );
      }
      board.prizesRemaining -= event.count;
      board.handCount += event.count;
      break;
    }
    case 'end-turn':
      playerBoard(state, event.nextPlayer, eventIndex);
      state.turn++;
      state.currentPlayer = event.nextPlayer;
      break;
    case 'declare-winner':
      playerBoard(state, event.player, eventIndex);
      if (state.winner)
        throw new BattleLogReplayError('winner has already been declared', eventIndex);
      state.winner = event.player;
      break;
    default:
      throw new BattleLogReplayError(
        `unsupported event type "${String(rawEvent.type)}"`,
        eventIndex
      );
  }
  return structuredClone(event);
}

/**
 * Validate and replay a battle log. Snapshot 0 is the initial state; snapshot n+1 is the state after
 * events[n]. Neither the input log nor earlier snapshots are mutated.
 */
export function replayBattleLog(input: unknown): ReplaySnapshot[] {
  if (!isRecord(input)) throw new BattleLogReplayError('battle log must be an object');
  if (input.schemaVersion !== BATTLE_LOG_SCHEMA_VERSION) {
    throw new BattleLogReplayError(
      `unsupported schemaVersion "${String(input.schemaVersion)}"; expected "${BATTLE_LOG_SCHEMA_VERSION}"`
    );
  }
  if (typeof input.battleId !== 'string' || input.battleId.length === 0) {
    throw new BattleLogReplayError('battleId must be a non-empty string');
  }
  validateInitialState(input.initialState);
  if (!Array.isArray(input.events)) throw new BattleLogReplayError('events must be an array');

  const state = cloneState(input.initialState);
  const snapshots: ReplaySnapshot[] = [{ eventIndex: -1, event: null, state: cloneState(state) }];
  input.events.forEach((rawEvent, eventIndex) => {
    const event = applyEvent(state, rawEvent, eventIndex);
    snapshots.push({ eventIndex, event, state: cloneState(state) });
  });
  return snapshots;
}
