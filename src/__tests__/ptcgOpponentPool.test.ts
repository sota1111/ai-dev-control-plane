import {
  OPPONENT_POOL_SCHEMA,
  OpponentPool,
  RatingEventStore,
  createRatingEvent,
  type OpponentSnapshot,
} from '../lib/ptcgOpponentPool.js';

const snapshot = (
  id: string,
  generation: number,
  status: 'active' | 'inactive' = 'active'
): OpponentSnapshot => ({
  schemaVersion: OPPONENT_POOL_SCHEMA,
  id,
  generation,
  status,
  artifactId: `artifact.${id}`,
  createdAt: '2026-07-20T00:00:00.000Z',
  metadata: { trainer: 'self-play-v1' },
});

describe('OpponentPool', () => {
  it('stores versioned snapshots and returns defensive, generation-ordered copies', () => {
    const pool = new OpponentPool([snapshot('model.g2', 2), snapshot('model.g1', 1)]);
    const listed = pool.list();
    expect(listed.map(({ id, generation, status }) => ({ id, generation, status }))).toEqual([
      { id: 'model.g1', generation: 1, status: 'active' },
      { id: 'model.g2', generation: 2, status: 'active' },
    ]);
    listed[0].metadata.trainer = 'mutated';
    expect(pool.list()[0].metadata.trainer).toBe('self-play-v1');
  });

  it('selects the same opponent for the same seed regardless of registration order', () => {
    const candidates = [snapshot('model.g1', 1), snapshot('model.g2', 2), snapshot('model.g3', 3)];
    const forward = new OpponentPool(candidates).select(4919);
    const reverse = new OpponentPool([...candidates].reverse()).select(4919);
    expect(forward).toEqual(reverse);
    expect(forward.candidateIds).toEqual(['model.g1', 'model.g2', 'model.g3']);
  });

  it('excludes inactive, explicitly excluded, and too-new snapshots', () => {
    const pool = new OpponentPool([
      snapshot('model.g1', 1),
      snapshot('model.g2', 2, 'inactive'),
      snapshot('model.g3', 3),
    ]);
    expect(pool.select(1, { maxGeneration: 2 }).snapshotId).toBe('model.g1');
    pool.setStatus('model.g1', 'inactive');
    expect(() => pool.select(1, { maxGeneration: 2 })).toThrow('no eligible active opponents');
    expect(() => pool.select(1, { excludeIds: ['model.g3'] })).toThrow(
      'no eligible active opponents'
    );
  });

  it('rejects duplicate snapshots and invalid seeds', () => {
    const pool = new OpponentPool([snapshot('model.g1', 1)]);
    expect(() => pool.register(snapshot('model.g1', 2))).toThrow('already exists');
    expect(() => pool.select(-1)).toThrow('non-negative');
  });
});

describe('RatingEventStore', () => {
  it('matches the standard equal-rating Elo fixture and conserves rating points', () => {
    const event = createRatingEvent({
      eventId: 'match.1',
      occurredAt: '2026-07-20T01:00:00.000Z',
      firstId: 'model.a',
      secondId: 'model.b',
      scoreFirst: 1,
      kFactor: 32,
      firstBefore: 1500,
      secondBefore: 1500,
    });
    expect(event.expectedFirst).toBe(0.5);
    expect(event.deltaFirst).toBe(16);
    expect(event.firstAfter).toBe(1516);
    expect(event.secondAfter).toBe(1484);
  });

  it('replays append-only events into the same ratings and records calculation inputs', () => {
    const store = new RatingEventStore(1500);
    store.append({
      eventId: 'match.1',
      occurredAt: '2026-07-20T01:00:00.000Z',
      firstId: 'model.a',
      secondId: 'model.b',
      scoreFirst: 1,
      kFactor: 32,
    });
    store.append({
      eventId: 'match.2',
      occurredAt: '2026-07-20T02:00:00.000Z',
      firstId: 'model.b',
      secondId: 'model.a',
      scoreFirst: 0.5,
      kFactor: 24,
    });
    const events = store.list();
    expect(events[1].firstBefore).toBe(events[0].secondAfter);
    expect(events[1].secondBefore).toBe(events[0].firstAfter);
    expect(store.replay(events)).toEqual(store.replay());
    expect(new RatingEventStore(1500, events).replay()).toEqual(store.replay());
  });

  it('rejects duplicate ids and detects a tampered calculation during audit replay', () => {
    const store = new RatingEventStore();
    store.append({
      eventId: 'match.1',
      occurredAt: '2026-07-20T01:00:00.000Z',
      firstId: 'model.a',
      secondId: 'model.b',
      scoreFirst: 1,
      kFactor: 32,
    });
    expect(() =>
      store.append({
        eventId: 'match.1',
        occurredAt: '2026-07-20T02:00:00.000Z',
        firstId: 'model.a',
        secondId: 'model.b',
        scoreFirst: 0,
        kFactor: 32,
      })
    ).toThrow('already exists');
    const tampered = store.list();
    tampered[0].firstAfter += 1;
    expect(() => store.replay(tampered)).toThrow('invalid firstAfter');
  });
});
