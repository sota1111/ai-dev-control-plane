const queueOrdering = require('../lib/queueOrdering');

describe('queueOrdering', () => {
  const now = new Date('2023-01-01T12:00:00Z');

  describe('getPriorityRank', () => {
    test('maps priorities correctly', () => {
      expect(queueOrdering.getPriorityRank(1)).toBe(1);
      expect(queueOrdering.getPriorityRank(2)).toBe(2);
      expect(queueOrdering.getPriorityRank(3)).toBe(3);
      expect(queueOrdering.getPriorityRank(4)).toBe(4);
      expect(queueOrdering.getPriorityRank(0)).toBe(5);
      expect(queueOrdering.getPriorityRank(null)).toBe(5);
      expect(queueOrdering.getPriorityRank(undefined)).toBe(5);
    });
  });

  describe('selectNextReadyIndex', () => {
    test('selects urgent item regardless of position', () => {
      const queue = [
        { issueId: 'normal', priority: 3, enqueuedAt: '2023-01-01T10:00:00Z' },
        { issueId: 'urgent', priority: 1, enqueuedAt: '2023-01-01T11:00:00Z' }
      ];
      expect(queueOrdering.selectNextReadyIndex(queue, { now })).toBe(1);
    });

    test('prefers group continuation after urgent', () => {
      const queue = [
        { issueId: 'other', priority: 2, enqueuedAt: '2023-01-01T10:00:00Z' },
        { issueId: 'group-item', priority: 3, queueGroup: 'group1', enqueuedAt: '2023-01-01T10:30:00Z' }
      ];
      expect(queueOrdering.selectNextReadyIndex(queue, { lastProcessedGroup: 'group1', now })).toBe(1);
    });

    test('urgent wins over group continuation', () => {
      const queue = [
        { issueId: 'urgent', priority: 1, enqueuedAt: '2023-01-01T11:00:00Z' },
        { issueId: 'group-item', priority: 3, queueGroup: 'group1', enqueuedAt: '2023-01-01T10:30:00Z' }
      ];
      expect(queueOrdering.selectNextReadyIndex(queue, { lastProcessedGroup: 'group1', now })).toBe(0);
    });

    test('normal priority order: rank -> retryAt -> enqueuedAt', () => {
      const queue = [
        { issueId: 'later-enqueued', priority: 3, enqueuedAt: '2023-01-01T11:00:00Z' },
        { issueId: 'earlier-enqueued', priority: 3, enqueuedAt: '2023-01-01T10:00:00Z' }
      ];
      expect(queueOrdering.selectNextReadyIndex(queue, { now })).toBe(1);

      const queue2 = [
        { issueId: 'high-priority', priority: 2, enqueuedAt: '2023-01-01T11:00:00Z' },
        { issueId: 'medium-priority', priority: 3, enqueuedAt: '2023-01-01T10:00:00Z' }
      ];
      expect(queueOrdering.selectNextReadyIndex(queue2, { now })).toBe(0);

      const queue3 = [
        { issueId: 'retry-at-past', priority: 3, retryAt: '2023-01-01T11:00:00Z', enqueuedAt: '2023-01-01T10:00:00Z' },
        { issueId: 'no-retry-at', priority: 3, enqueuedAt: '2023-01-01T10:30:00Z' }
      ];
      // no-retry-at has retryAt = -Infinity, so it wins
      expect(queueOrdering.selectNextReadyIndex(queue3, { now })).toBe(1);
    });

    test('ignores items not yet ready', () => {
      const queue = [
        { issueId: 'waiting', priority: 1, retryAt: '2023-01-01T13:00:00Z' },
        { issueId: 'ready', priority: 3, retryAt: '2023-01-01T11:00:00Z' }
      ];
      expect(queueOrdering.selectNextReadyIndex(queue, { now })).toBe(1);
    });

    test('returns null if no items are ready', () => {
      const queue = [
        { issueId: 'waiting', priority: 1, retryAt: '2023-01-01T13:00:00Z' }
      ];
      expect(queueOrdering.selectNextReadyIndex(queue, { now })).toBe(null);
    });

    test('does not mutate input queue', () => {
      const queue = [{ issueId: '1' }, { issueId: '2' }];
      const copy = JSON.parse(JSON.stringify(queue));
      queueOrdering.selectNextReadyIndex(queue, { now });
      expect(queue).toEqual(copy);
    });
  });

  describe('previewQueueOrder', () => {
    test('simulates full execution order', () => {
      const queue = [
        { issueId: 'normal1', priority: 3, enqueuedAt: '2023-01-01T10:00:00Z' },
        { issueId: 'group-item1', priority: 3, queueGroup: 'normal1', enqueuedAt: '2023-01-01T10:05:00Z' },
        { issueId: 'urgent1', priority: 1, enqueuedAt: '2023-01-01T11:00:00Z' },
        { issueId: 'waiting1', priority: 1, retryAt: '2023-01-01T13:00:00Z' }
      ];

      const { ready, waiting } = queueOrdering.previewQueueOrder(queue, { now });

      // Execution order:
      // 1. urgent1 (global urgent) -> lastProcessedGroup = urgent1
      // 2. normal1 (best of remaining ready) -> lastProcessedGroup = normal1
      // 3. group-item1 (group continuation)
      expect(ready.map((i: any) => i.issueId)).toEqual(['urgent1', 'normal1', 'group-item1']);
      expect(waiting.map((i: any) => i.issueId)).toEqual(['waiting1']);
    });

    test('waiting items are sorted by retryAt', () => {
      const queue = [
        { issueId: 'waiting-late', retryAt: '2023-01-01T15:00:00Z' },
        { issueId: 'waiting-early', retryAt: '2023-01-01T13:00:00Z' }
      ];
      const { ready, waiting } = queueOrdering.previewQueueOrder(queue, { now });
      expect(ready).toHaveLength(0);
      expect(waiting.map((i: any) => i.issueId)).toEqual(['waiting-early', 'waiting-late']);
    });
  });
});
