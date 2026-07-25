import { replayBattleLog, type BattleLogEvent } from '../lib/ptcgBattleLogReplay.js';
import {
  convertCaptureToBattleLog,
  type BattleCapture,
  type CaptureCard,
  type CaptureFrame,
  type CapturePlayerBoard,
} from '../lib/ptcgObservationToBattleLog.js';

const card = (serial: number, cardId: number, maxHp: number, hp: number, energy = 0): CaptureCard => ({
  serial,
  cardId,
  hp,
  maxHp,
  energyCount: energy,
  toolCount: 0,
});

const board = (over: Partial<CapturePlayerBoard> = {}): CapturePlayerBoard => ({
  active: [],
  bench: [],
  deckCount: 47,
  handCount: 6,
  prizeCount: 6,
  discardCount: 0,
  ...over,
});

const frame = (turn: number, players: [CapturePlayerBoard, CapturePlayerBoard]): CaptureFrame => ({
  turn,
  yourIndex: 0,
  firstPlayer: 0,
  result: -1,
  players,
});

const capture = (frames: CaptureFrame[], over: Partial<BattleCapture> = {}): BattleCapture => ({
  captureVersion: 'ptcg-battle-capture/v1',
  seed: 1,
  players: { '0': 'take', '1': 'obo' },
  outcome: 'first',
  winnerSeat: 0,
  fault: null,
  decisions: frames.length,
  frames,
  ...over,
});

describe('convertCaptureToBattleLog', () => {
  it('produces a schema-valid log that replays without error', () => {
    const cap = capture([
      frame(0, [board(), board()]),
      frame(0, [board({ active: [card(5, 721, 150, 150)] }), board({ active: [card(103, 722, 90, 90)] })]),
    ]);
    const log = convertCaptureToBattleLog(cap);
    expect(log.schemaVersion).toBe('ptcg-battle-log/v1');
    // Self-validation inside the converter would have thrown; assert it replays.
    const snapshots = replayBattleLog(log);
    expect(snapshots.length).toBe(log.events.length + 1);
  });

  it('maps opening Pokemon to play-active and preserves identity/HP', () => {
    const cap = capture([
      frame(0, [board(), board()]),
      frame(0, [board({ active: [card(5, 721, 150, 150)] }), board({ active: [card(103, 722, 90, 90)] })]),
    ]);
    const log = convertCaptureToBattleLog(cap, { playerNames: ['take', 'obo'] });
    const final = replayBattleLog(log).at(-1)!.state;
    expect(final.players.take.active).toMatchObject({ id: 'take-s5', name: 'card-721', maxHp: 150 });
    expect(final.players.obo.active).toMatchObject({ id: 'obo-s103', name: 'card-722', maxHp: 90 });
  });

  it('reconstructs damage, knockout, prize, and the declared winner', () => {
    const cap = capture([
      frame(0, [board(), board()]),
      frame(0, [board({ active: [card(5, 721, 150, 150)] }), board({ active: [card(103, 722, 90, 90)] })]),
      // obo active drops to 0 hp then leaves the board; take takes a prize.
      frame(1, [board({ active: [card(5, 721, 150, 150)] }), board({ active: [], prizeCount: 6 })]),
      frame(1, [board({ active: [card(5, 721, 150, 150)], prizeCount: 5 }), board({ active: [] })]),
    ]);
    const log = convertCaptureToBattleLog(cap);
    const types = log.events.map((event: BattleLogEvent) => event.type);
    expect(types).toContain('knockout');
    expect(types).toContain('take-prize');
    expect(types).toContain('declare-winner');
    const final = replayBattleLog(log).at(-1)!.state;
    expect(final.winner).toBe('take');
    expect(final.players.obo.active).toBeNull();
    expect(final.players.take.prizesRemaining).toBe(5);
  });

  it('emits one attach-energy per added energy', () => {
    const cap = capture([
      frame(0, [board(), board()]),
      frame(0, [board({ active: [card(5, 721, 150, 150, 0)] }), board({ active: [card(103, 722, 90, 90)] })]),
      frame(1, [board({ active: [card(5, 721, 150, 150, 2)] }), board({ active: [card(103, 722, 90, 90)] })]),
    ]);
    const log = convertCaptureToBattleLog(cap);
    const attaches = log.events.filter(
      (event: BattleLogEvent) => event.type === 'attach-energy' && event.player === 'take'
    );
    expect(attaches.length).toBe(2);
    const final = replayBattleLog(log).at(-1)!.state;
    expect(final.players.take.active?.energy.length).toBe(2);
  });

  it('keeps deck count faithful to the capture via draw events', () => {
    const cap = capture([
      frame(0, [board({ deckCount: 40 }), board({ deckCount: 40 })]),
      frame(0, [board({ deckCount: 37 }), board({ deckCount: 40 })]),
    ]);
    const log = convertCaptureToBattleLog(cap);
    const final = replayBattleLog(log).at(-1)!.state;
    expect(final.players.take.deckCount).toBe(37);
  });

  it('rejects an empty capture', () => {
    expect(() => convertCaptureToBattleLog(capture([]))).toThrow();
  });
});
