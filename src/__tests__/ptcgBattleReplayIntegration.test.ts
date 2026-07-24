import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replayBattleLog } from '../lib/ptcgBattleLogReplay.js';
import {
  createTimelineViewModel,
  renderBattleTimelinePage,
} from '../lib/ptcgBattleTimelineViewer.js';

const fixturePath = join(process.cwd(), 'src/__tests__/fixtures/battle-log.real-anonymized.json');
const loadFixture = (): any => JSON.parse(readFileSync(fixturePath, 'utf8'));

describe('real battle replay integration', () => {
  test('replays an anonymized real match from setup through the declared winner', () => {
    const log = loadFixture();
    const snapshots = replayBattleLog(log);

    expect(snapshots).toHaveLength(log.events.length + 1);
    expect(snapshots[0].state).toEqual(log.initialState);
    expect(snapshots.at(-1)?.eventIndex).toBe(log.events.length - 1);
    expect(snapshots.at(-1)?.state.winner).toBe('player-b');
    expect(snapshots.at(-1)?.state.players['player-b'].prizesRemaining).toBe(0);
  });

  test('matches board checkpoints before and after major events', () => {
    const snapshots = replayBattleLog(loadFixture());

    expect(snapshots[6].state).toMatchObject({ turn: 2, currentPlayer: 'player-b' });
    expect(snapshots[9].state.players['player-a'].active).toMatchObject({
      id: 'a-01',
      damage: 70,
      energy: ['fire'],
    });
    expect(snapshots[17].state.players['player-a']).toMatchObject({
      active: null,
      discard: ['a-01', 'fire', 'fire'],
    });
    expect(snapshots[18].state.players['player-b']).toMatchObject({
      prizesRemaining: 4,
      handCount: 9,
    });
    expect(snapshots[22].state.players['player-b']).toMatchObject({
      active: null,
      discard: ['b-01', 'grass'],
    });
    expect(snapshots[28].state.players['player-b'].prizesRemaining).toBe(0);
  });

  test('makes every replay point observable in the timeline viewer', () => {
    const log = loadFixture();
    const model = createTimelineViewModel(log);
    const page = renderBattleTimelinePage(log);

    expect(model.snapshots).toHaveLength(30);
    expect(model.descriptions).toHaveLength(model.snapshots.length);
    expect(model.descriptions.at(-1)).toBe('player-b の勝利');
    expect(page).toContain('type="range" min="0" max="29"');
    expect(page).toContain('勝者: player-b');
    expect(page).toContain('炎ポケモンex');
    expect(page).toContain('草ポケモンex');
  });

  test.each([
    [
      'unsupported event',
      (log: any) => log.events.splice(8, 0, { type: 'retreat' }),
      'event[8]: unsupported event type "retreat"',
    ],
    [
      'corrupted transition',
      (log: any) => {
        log.events[15].amount = -1;
      },
      'event[15]: amount must be a non-negative integer',
    ],
  ])('surfaces %s with an indexed diagnostic', (_name, corrupt, message) => {
    const log = loadFixture();
    corrupt(log);
    expect(() => createTimelineViewModel(log)).toThrow(message);
  });

  test('keeps a large log interactive-sized and replays it within a practical budget', () => {
    const log = loadFixture();
    const cycles = 250;
    log.battleId = 'large-anonymized-replay';
    log.events = Array.from({ length: cycles }, (_, index) => [
      { type: 'draw', player: index % 2 === 0 ? 'player-a' : 'player-b', count: 1 },
      { type: 'end-turn', nextPlayer: index % 2 === 0 ? 'player-b' : 'player-a' },
    ]).flat();
    log.initialState.players['player-a'].deckCount = cycles;
    log.initialState.players['player-b'].deckCount = cycles;

    const started = performance.now();
    const model = createTimelineViewModel(log);
    const elapsedMs = performance.now() - started;

    expect(model.snapshots).toHaveLength(501);
    expect(elapsedMs).toBeLessThan(1000);
    expect(renderBattleTimelinePage(log).length).toBeLessThan(5_000_000);
  });
});
