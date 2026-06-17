/**
 * Logic for determining the execution order of the queue.
 */

interface QueueItem {
  priority?: number | null;
  priorityRank?: number;
  retryAt?: string | null;
  enqueuedAt?: string | null;
  queueGroup?: string | null;
  queueGroupOrder?: string | null;
  issueId?: string;
  issueIdentifier?: string | null;
}

interface SelectNextOptions {
  lastProcessedGroup?: string | null;
  now?: Date;
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

  // Helper: compare two candidate indices, returning the better one
  function betterIndex(aIdx: number, bIdx: number, groupMode: boolean = false): number {
    const a = queue[aIdx];
    const b = queue[bIdx];
    const rankA = effectiveRank(a);
    const rankB = effectiveRank(b);

    if (rankA < rankB) return aIdx;
    if (rankA > rankB) return bIdx;

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
  const urgentIndices = readyIndices.filter(i => effectiveRank(queue[i]) === 1);
  if (urgentIndices.length > 0) {
    let bestUrgent = urgentIndices[0];
    for (const i of urgentIndices.slice(1)) {
      bestUrgent = betterIndex(bestUrgent, i);
    }
    return bestUrgent;
  }

  // Step 2: If lastProcessedGroup is set, check for items in that group
  if (lastProcessedGroup) {
    const groupIndices = readyIndices.filter(i => queue[i].queueGroup === lastProcessedGroup);
    if (groupIndices.length > 0) {
      let bestGroup = groupIndices[0];
      for (const i of groupIndices.slice(1)) {
        bestGroup = betterIndex(bestGroup, i, true);
      }
      return bestGroup;
    }
  }

  // Step 3: Normal priority order (priorityRank → retryAt → enqueuedAt)
  let bestIndex = readyIndices[0];
  for (const i of readyIndices.slice(1)) {
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
      break;
    }

    const selected = currentQueue.splice(nextIdx, 1)[0];
    ready.push(selected);
    currentGroup = selected.issueId || selected.issueIdentifier || null;
  }

  return { ready, waiting };
}
