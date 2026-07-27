import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BATTLE_LOG_SCHEMA_VERSION,
  BattleLogReplayError,
  replayBattleLog,
} from '../lib/ptcgBattleLogReplay.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));

describe('replayBattleLog', () => {
  it('preserves optional retreat energy costs for board summaries', () => {
    const log = load('battle-log.snapshot.json') as {
      initialState: {
        players: Record<string, { active: Record<string, unknown> | null }>;
      };
    };
    const player = Object.values(log.initialState.players).find((value) => value.active !== null);
    if (!player?.active) throw new Error('fixture must contain an active Pokemon');
    player.active.retreatCost = ['無', '無'];

    const snapshot = replayBattleLog(log).at(0);
    const active = Object.values(snapshot!.state.players).find((board) => board.active)?.active;
    expect(active?.retreatCost).toEqual(['無', '無']);
  });

  it('reconstructs the board after every event in order', () => {
    const snapshots = replayBattleLog(load('battle-log.valid.json'));
    expect(snapshots).toHaveLength(8);
    expect(snapshots.map((snapshot) => snapshot.eventIndex)).toEqual([-1, 0, 1, 2, 3, 4, 5, 6]);
    expect(snapshots[1].state.players.matsu.active?.id).toBe('m1');
    expect(snapshots[3].state.players.matsu.active?.energy).toEqual(['fire']);
    expect(snapshots[4].state.players.take.active?.damage).toBe(90);
    expect(snapshots[5].state.players.take.active).toBeNull();
    expect(snapshots[5].state.players.take.discard).toEqual(['t1']);
    expect(snapshots[6].state.players.matsu.prizesRemaining).toBe(5);
    expect(snapshots[7].state.winner).toBe('matsu');
  });

  it('is deterministic and does not mutate its input', () => {
    const log = load('battle-log.valid.json');
    const before = JSON.stringify(log);
    expect(replayBattleLog(log)).toEqual(replayBattleLog(log));
    expect(JSON.stringify(log)).toBe(before);
  });

  it('reports an unsupported event with its event index', () => {
    expect(() => replayBattleLog(load('battle-log.invalid.json'))).toThrow(
      new BattleLogReplayError('unsupported event type "teleport"', 0)
    );
  });

  it('rejects unsupported schema versions', () => {
    const log = load('battle-log.valid.json') as Record<string, unknown>;
    log.schemaVersion = 'ptcg-battle-log/v2';
    expect(() => replayBattleLog(log)).toThrow(
      `unsupported schemaVersion "ptcg-battle-log/v2"; expected "${BATTLE_LOG_SCHEMA_VERSION}"`
    );
  });

  it('rejects an event that violates board invariants', () => {
    const log = load('battle-log.valid.json') as { events: Record<string, unknown>[] };
    log.events[3].amount = 0;
    expect(() => replayBattleLog(log)).toThrow('event[3]: damage amount must be positive');
  });

  it('keeps prior snapshots immutable as later events are applied', () => {
    const snapshots = replayBattleLog(load('battle-log.valid.json'));
    expect(snapshots[3].state.players.take.active?.damage).toBe(0);
    expect(snapshots[4].state.players.take.active?.damage).toBe(90);
  });

  it('preserves optional attacks in concrete-card snapshot logs', () => {
    const snapshots = replayBattleLog(load('battle-log.snapshot.json'));
    expect(snapshots[0].state.players['あなた'].active?.attacks).toEqual([
      { name: 'エレキサークル', damage: '60', cost: ['雷'] },
      { name: 'サンダーボルト', damage: '200', cost: ['雷', '雷', '無'] },
    ]);
  });
});
