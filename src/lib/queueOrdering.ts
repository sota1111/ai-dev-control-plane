/**
 * Logic for determining the execution order of the queue.
 */

interface QueueItem {
  priority?: number | null;
  priorityRank?: number;
  retryAt?: string | null;
  enqueuedAt?: string | null;
  issueUpdatedAt?: string | null;
  queueGroup?: string | null;
  queueGroupOrder?: string | null;
  blockedByIssueIds?: string[] | null;
  issueId?: string;
  issueIdentifier?: string | null;
}

interface SelectNextOptions {
  lastProcessedGroup?: string | null;
  now?: Date;
}

export function findDependencyCycle(queue: QueueItem[]): string[] {
  const keys = new Map<string, number>();
  queue.forEach((item, index) => {
    if (item.issueId) keys.set(item.issueId, index);
    if (item.issueIdentifier) keys.set(item.issueIdentifier, index);
  });
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const path: number[] = [];
  const visit = (index: number): string[] => {
    if (visiting.has(index)) {
      const start = path.indexOf(index);
      return path.slice(start).concat(index).map(i => queue[i].issueIdentifier || queue[i].issueId || String(i));
    }
    if (visited.has(index)) return [];
    visiting.add(index);
    path.push(index);
    for (const blocker of queue[index].blockedByIssueIds || []) {
      const blockerIndex = keys.get(blocker);
      if (blockerIndex == null) continue;
      const cycle = visit(blockerIndex);
      if (cycle.length) return cycle;
    }
    path.pop();
    visiting.delete(index);
    visited.add(index);
    return [];
  };
  for (let i = 0; i < queue.length; i++) {
    const cycle = visit(i);
    if (cycle.length) return cycle;
  }
  return [];
}

/**
 * Maps Linear priority to a numerical rank.
 * 1: Urgent, 2: High, 3: Medium, 4: Low, 5: None/Other
 */
export function getPriorityRank(priority: number | null | undefined): number {
  if (priority === 1) return 1; // Urgent
  if (priority === 2) return 2; // High
  if (priority === 3) return 3; // Medium
  if (priority === 4) return 4; // Low
  return 5; // No priority (0), null, undefined, or invalid value
}

/**
 * Gets the effective priority rank for an item, favoring priorityRank if set.
 */
export function effectiveRank(item: QueueItem): number {
  return item.priorityRank != null ? item.priorityRank : getPriorityRank(item.priority);
}

/**
 * Enqueue-time ordering (SOT-1352).
 *
 * Returns a NEW array (the input is never mutated) sorted ascending by the STATIC priority
 * dimensions only: effectiveRank → issueUpdatedAt (newest first) → retryAt → enqueuedAt. This is applied when a webhook enqueues
 * an item so the persisted queue is always stored in priority order, instead of evaluating priority
 * only at execution (dequeue) time.
 *
 * The DYNAMIC rules that genuinely depend on runtime state — `retryAt` readiness gating,
 * `lastProcessedGroup` group continuation, and Urgent override — still live in
 * `selectNextReadyIndex` and run at dequeue time; this helper deliberately does NOT use `now` or
 * `queueGroup`. The comparator is stable (returns 0 on a full tie), so equal items keep input order.
 */
export function sortQueueByPriority<T extends QueueItem>(queue: T[]): T[] {
  const baseSorted = [...queue].sort((a, b) => {
    const rankA = effectiveRank(a);
    const rankB = effectiveRank(b);
    if (rankA !== rankB) return rankA - rankB;

    // Same-priority issues are ordered by their latest Linear update.
    // Missing timestamps sort last so legacy queue entries remain valid.
    const updatedA = a.issueUpdatedAt ? new Date(a.issueUpdatedAt).getTime() : -Infinity;
    const updatedB = b.issueUpdatedAt ? new Date(b.issueUpdatedAt).getTime() : -Infinity;
    if (updatedA !== updatedB) return updatedB - updatedA;

    // retryAt ascending; null/missing = earliest
    const retryA = a.retryAt ? new Date(a.retryAt).getTime() : -Infinity;
    const retryB = b.retryAt ? new Date(b.retryAt).getTime() : -Infinity;
    if (retryA !== retryB) return retryA - retryB;

    // enqueuedAt ascending; null/missing = earliest
    const enqA = a.enqueuedAt ? new Date(a.enqueuedAt).getTime() : 0;
    const enqB = b.enqueuedAt ? new Date(b.enqueuedAt).getTime() : 0;
    if (enqA !== enqB) return enqA - enqB;

    return 0;
  });
  const keyToIndex = new Map<string, number>();
  baseSorted.forEach((item, index) => {
    if (item.issueId) keyToIndex.set(item.issueId, index);
    if (item.issueIdentifier) keyToIndex.set(item.issueIdentifier, index);
  });
  const dependents = new Map<number, number[]>();
  const indegree = baseSorted.map(() => 0);
  baseSorted.forEach((item, dependentIndex) => {
    const blockerIndices = new Set((item.blockedByIssueIds || [])
      .map(key => keyToIndex.get(key))
      .filter((index): index is number => index != null && index !== dependentIndex));
    for (const blockerIndex of blockerIndices) {
      indegree[dependentIndex]++;
      dependents.set(blockerIndex, [...(dependents.get(blockerIndex) || []), dependentIndex]);
    }
  });
  const ready = indegree.map((degree, index) => ({ degree, index }))
    .filter(({ degree }) => degree === 0).map(({ index }) => index);
  const result: T[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => a - b);
    const index = ready.shift()!;
    result.push(baseSorted[index]);
    for (const dependentIndex of dependents.get(index) || []) {
      indegree[dependentIndex]--;
      if (indegree[dependentIndex] === 0) ready.push(dependentIndex);
    }
  }
  if (result.length < baseSorted.length) {
    const emitted = new Set(result);
    result.push(...baseSorted.filter(item => !emitted.has(item)));
  }
  return result;
}

/**
 * Selects the index of the next item to execute from the queue.
 * 
 * Logic (Step1 -> Step2 -> Step3):
 * 1. Urgent (rank 1) items globally.
 * 2. Group continuation (items with queueGroup === lastProcessedGroup).
 * 3. Normal priority (rank -> retryAt -> enqueuedAt).
 * 
 * Only items where retryAt is null/missing or in the past are eligible.
 */
export function selectNextReadyIndex(queue: QueueItem[], { lastProcessedGroup = null, now = new Date() }: SelectNextOptions = {}): number | null {
  // Filter to ready indices
  const readyIndices: number[] = queue.reduce((acc: number[], item, i) => {
    if (!item.retryAt || new Date(item.retryAt) <= now) acc.push(i);
    return acc;
  }, []);

  if (readyIndices.length === 0) return null;
  const queuedKeys = new Set<string>();
  queue.forEach(item => {
    if (item.issueId) queuedKeys.add(item.issueId);
    if (item.issueIdentifier) queuedKeys.add(item.issueIdentifier);
  });
  const dependencyReadyIndices = readyIndices.filter(i =>
    !(queue[i].blockedByIssueIds || []).some(blockerId => queuedKeys.has(blockerId)));
  let selectableIndices = dependencyReadyIndices;
  if (selectableIndices.length === 0) {
    return null;
  }

  // Helper: compare two candidate indices, returning the better one
  function betterIndex(aIdx: number, bIdx: number, groupMode: boolean = false): number {
    const a = queue[aIdx];
    const b = queue[bIdx];
    const rankA = effectiveRank(a);
    const rankB = effectiveRank(b);

    if (rankA < rankB) return aIdx;
    if (rankA > rankB) return bIdx;

    const updatedA = a.issueUpdatedAt ? new Date(a.issueUpdatedAt).getTime() : -Infinity;
    const updatedB = b.issueUpdatedAt ? new Date(b.issueUpdatedAt).getTime() : -Infinity;
    if (updatedA > updatedB) return aIdx;
    if (updatedA < updatedB) return bIdx;

    if (groupMode) {
      // Within group: compare queueGroupOrder first (lower/earlier wins, null last)
      const orderA = a.queueGroupOrder != null ? new Date(a.queueGroupOrder).getTime() : Infinity;
      const orderB = b.queueGroupOrder != null ? new Date(b.queueGroupOrder).getTime() : Infinity;
      if (orderA < orderB) return aIdx;
      if (orderA > orderB) return bIdx;
    } else {
      // Normal mode: compare retryAt (null = immediate = wins)
      const retryA = a.retryAt ? new Date(a.retryAt).getTime() : -Infinity;
      const retryB = b.retryAt ? new Date(b.retryAt).getTime() : -Infinity;
      if (retryA < retryB) return aIdx;
      if (retryA > retryB) return bIdx;
    }

    // Compare enqueuedAt (earlier wins)
    const enqA = a.enqueuedAt ? new Date(a.enqueuedAt).getTime() : 0;
    const enqB = b.enqueuedAt ? new Date(b.enqueuedAt).getTime() : 0;
    return enqA <= enqB ? aIdx : bIdx;
  }

  // Step 1: Check for Urgent items (priorityRank === 1) — always highest priority
  const urgentIndices = selectableIndices.filter(i => effectiveRank(queue[i]) === 1);
  if (urgentIndices.length > 0) {
    let bestUrgent = urgentIndices[0];
    for (const i of urgentIndices.slice(1)) {
      bestUrgent = betterIndex(bestUrgent, i);
    }
    return bestUrgent;
  }

  // Step 2: If lastProcessedGroup is set, check for items in that group
  if (lastProcessedGroup) {
    const groupIndices = selectableIndices.filter(i => queue[i].queueGroup === lastProcessedGroup);
    if (groupIndices.length > 0) {
      let bestGroup = groupIndices[0];
      for (const i of groupIndices.slice(1)) {
        bestGroup = betterIndex(bestGroup, i, true);
      }
      return bestGroup;
    }
  }

  // Step 3: Normal priority order (priorityRank → retryAt → enqueuedAt)
  let bestIndex = selectableIndices[0];
  for (const i of selectableIndices.slice(1)) {
    bestIndex = betterIndex(bestIndex, i);
  }

  return bestIndex;
}

/**
 * Previews the full execution order of the queue.
 * Returns { ready: [...items], waiting: [...items] }.
 */
export function previewQueueOrder(queue: QueueItem[], { lastProcessedGroup = null, now = new Date() }: SelectNextOptions = {}): { ready: QueueItem[], waiting: QueueItem[] } {
  const ready: QueueItem[] = [];
  const waiting: QueueItem[] = [];

  const executable: QueueItem[] = [];
  const notReady: QueueItem[] = [];

  for (const item of queue) {
    if (!item.retryAt || new Date(item.retryAt) <= now) {
      executable.push(item);
    } else {
      notReady.push(item);
    }
  }

  // Sort waiting items by retryAt ascending
  waiting.push(...notReady.sort((a, b) => {
    const timeA = a.retryAt ? new Date(a.retryAt).getTime() : 0;
    const timeB = b.retryAt ? new Date(b.retryAt).getTime() : 0;
    return timeA - timeB;
  }));

  // Simulate selection for ready items
  let currentQueue = [...executable];
  let currentGroup = lastProcessedGroup;

  while (currentQueue.length > 0) {
    const nextIdx = selectNextReadyIndex(currentQueue, { lastProcessedGroup: currentGroup, now });
    if (nextIdx === null) {
      waiting.push(...currentQueue);
      break;
    }

    const selected = currentQueue.splice(nextIdx, 1)[0];
    ready.push(selected);
    currentGroup = selected.issueId || selected.issueIdentifier || null;
  }

  return { ready, waiting };
}
