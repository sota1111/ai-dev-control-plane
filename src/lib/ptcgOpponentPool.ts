import crypto from 'node:crypto';

export const OPPONENT_POOL_SCHEMA = 'ptcg-opponent-pool/v1' as const;
export const RATING_EVENT_SCHEMA = 'ptcg-rating-event/v1' as const;

export type SnapshotStatus = 'active' | 'inactive';

export interface OpponentSnapshot {
  schemaVersion: typeof OPPONENT_POOL_SCHEMA;
  id: string;
  generation: number;
  status: SnapshotStatus;
  artifactId: string;
  createdAt: string;
  metadata: Record<string, string>;
}

export interface OpponentSelection {
  snapshotId: string;
  seed: number;
  candidateIds: string[];
}

export interface RatingEvent {
  schemaVersion: typeof RATING_EVENT_SCHEMA;
  eventId: string;
  occurredAt: string;
  firstId: string;
  secondId: string;
  scoreFirst: 0 | 0.5 | 1;
  kFactor: number;
  firstBefore: number;
  secondBefore: number;
  expectedFirst: number;
  deltaFirst: number;
  firstAfter: number;
  secondAfter: number;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function stableUint32(value: string): number {
  return Number.parseInt(crypto.createHash('sha256').update(value).digest('hex').slice(0, 8), 16);
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

function assertSnapshot(snapshot: OpponentSnapshot): void {
  if (snapshot.schemaVersion !== OPPONENT_POOL_SCHEMA)
    throw new Error(`snapshot schemaVersion must be ${OPPONENT_POOL_SCHEMA}`);
  if (!ID_RE.test(snapshot.id)) throw new Error('snapshot id must be a stable lowercase id');
  if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0)
    throw new Error('snapshot generation must be a non-negative safe integer');
  if (snapshot.status !== 'active' && snapshot.status !== 'inactive')
    throw new Error('snapshot status must be active or inactive');
  if (!snapshot.artifactId) throw new Error('snapshot artifactId is required');
  if (!Number.isFinite(Date.parse(snapshot.createdAt)))
    throw new Error('snapshot createdAt is invalid');
}

/** Versioned in-memory pool. Persistence can store the returned snapshots as plain JSON. */
export class OpponentPool {
  private readonly snapshots = new Map<string, OpponentSnapshot>();

  constructor(initial: OpponentSnapshot[] = []) {
    initial.forEach((snapshot) => this.register(snapshot));
  }

  register(snapshot: OpponentSnapshot): void {
    assertSnapshot(snapshot);
    if (this.snapshots.has(snapshot.id)) throw new Error(`snapshot ${snapshot.id} already exists`);
    this.snapshots.set(snapshot.id, structuredClone(snapshot));
  }

  setStatus(id: string, status: SnapshotStatus): void {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) throw new Error(`unknown snapshot ${id}`);
    snapshot.status = status;
  }

  list(status?: SnapshotStatus): OpponentSnapshot[] {
    return [...this.snapshots.values()]
      .filter((snapshot) => status === undefined || snapshot.status === status)
      .sort((a, b) => a.generation - b.generation || a.id.localeCompare(b.id))
      .map((snapshot) => structuredClone(snapshot));
  }

  /**
   * Samples only active snapshots. Candidate sorting plus a SHA-256-derived index makes selection
   * independent of registration order and reproducible across processes for the same seed/input.
   */
  select(
    seed: number,
    options: { excludeIds?: string[]; maxGeneration?: number } = {}
  ): OpponentSelection {
    if (!Number.isSafeInteger(seed) || seed < 0)
      throw new Error('selection seed must be a non-negative safe integer');
    if (
      options.maxGeneration !== undefined &&
      (!Number.isSafeInteger(options.maxGeneration) || options.maxGeneration < 0)
    )
      throw new Error('maxGeneration must be a non-negative safe integer');
    const excluded = new Set(options.excludeIds ?? []);
    const candidates = this.list('active').filter(
      (snapshot) =>
        !excluded.has(snapshot.id) &&
        (options.maxGeneration === undefined || snapshot.generation <= options.maxGeneration)
    );
    if (candidates.length === 0) throw new Error('no eligible active opponents');
    const candidateIds = candidates.map((snapshot) => snapshot.id);
    const index = stableUint32(`${seed}:${candidateIds.join(',')}`) % candidates.length;
    return { snapshotId: candidates[index].id, seed, candidateIds };
  }
}

export function expectedElo(firstRating: number, secondRating: number): number {
  assertFinite(firstRating, 'firstRating');
  assertFinite(secondRating, 'secondRating');
  return 1 / (1 + 10 ** ((secondRating - firstRating) / 400));
}

export function createRatingEvent(input: {
  eventId: string;
  occurredAt: string;
  firstId: string;
  secondId: string;
  scoreFirst: 0 | 0.5 | 1;
  kFactor: number;
  firstBefore: number;
  secondBefore: number;
}): RatingEvent {
  if (!ID_RE.test(input.eventId)) throw new Error('eventId must be a stable lowercase id');
  if (!ID_RE.test(input.firstId) || !ID_RE.test(input.secondId) || input.firstId === input.secondId)
    throw new Error('rating participants must be distinct stable ids');
  if (!Number.isFinite(Date.parse(input.occurredAt))) throw new Error('occurredAt is invalid');
  if (![0, 0.5, 1].includes(input.scoreFirst)) throw new Error('scoreFirst must be 0, 0.5, or 1');
  if (!Number.isFinite(input.kFactor) || input.kFactor <= 0)
    throw new Error('kFactor must be positive');
  assertFinite(input.firstBefore, 'firstBefore');
  assertFinite(input.secondBefore, 'secondBefore');
  const expectedFirst = expectedElo(input.firstBefore, input.secondBefore);
  const deltaFirst = input.kFactor * (input.scoreFirst - expectedFirst);
  return {
    schemaVersion: RATING_EVENT_SCHEMA,
    ...input,
    expectedFirst,
    deltaFirst,
    firstAfter: input.firstBefore + deltaFirst,
    secondAfter: input.secondBefore - deltaFirst,
  };
}

/** Append-only event store that validates every event against ratings reconstructed so far. */
export class RatingEventStore {
  private readonly events: RatingEvent[] = [];

  constructor(
    private readonly initialRating = 1500,
    initialEvents: RatingEvent[] = []
  ) {
    assertFinite(initialRating, 'initialRating');
    this.replay(initialEvents);
    this.events.push(...structuredClone(initialEvents));
  }

  append(
    input: Omit<Parameters<typeof createRatingEvent>[0], 'firstBefore' | 'secondBefore'>
  ): RatingEvent {
    if (this.events.some((event) => event.eventId === input.eventId))
      throw new Error(`rating event ${input.eventId} already exists`);
    const ratings = this.replay();
    const event = createRatingEvent({
      ...input,
      firstBefore: ratings[input.firstId] ?? this.initialRating,
      secondBefore: ratings[input.secondId] ?? this.initialRating,
    });
    this.events.push(event);
    return structuredClone(event);
  }

  list(): RatingEvent[] {
    return structuredClone(this.events);
  }

  replay(events: RatingEvent[] = this.events): Record<string, number> {
    const ratings: Record<string, number> = {};
    const seen = new Set<string>();
    for (const stored of events) {
      if (seen.has(stored.eventId)) throw new Error(`duplicate rating event ${stored.eventId}`);
      seen.add(stored.eventId);
      const expected = createRatingEvent({
        eventId: stored.eventId,
        occurredAt: stored.occurredAt,
        firstId: stored.firstId,
        secondId: stored.secondId,
        scoreFirst: stored.scoreFirst,
        kFactor: stored.kFactor,
        firstBefore: ratings[stored.firstId] ?? this.initialRating,
        secondBefore: ratings[stored.secondId] ?? this.initialRating,
      });
      for (const key of [
        'firstBefore',
        'secondBefore',
        'expectedFirst',
        'deltaFirst',
        'firstAfter',
        'secondAfter',
      ] as const) {
        if (Math.abs(expected[key] - stored[key]) > 1e-10)
          throw new Error(`rating event ${stored.eventId} has invalid ${key}`);
      }
      ratings[stored.firstId] = expected.firstAfter;
      ratings[stored.secondId] = expected.secondAfter;
    }
    return ratings;
  }
}
