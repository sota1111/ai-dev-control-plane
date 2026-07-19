import fs from 'node:fs';
import path from 'node:path';
import * as queueOrdering from './queueOrdering.js';
import { getPriorityRank } from './queueOrdering.js';
import { isTerminalState } from './issueState.js';
import { linearQuery, fetchActiveIssues } from './linearApi.js';
import type { QueueItem, QueueHistoryItem } from '../runner.js';

/**
 * Persistent queue store (active queue + past-queue history) extracted from runner.ts (SOT-935 R4).
 * Shared primitives owned by runner.ts (log / LOG_DIR / QUEUE_FILE / HISTORY_FILE / MAX_QUEUE_HISTORY /
 * QUEUE_ITEM_TTL_DAYS) are injected once at module init via configureQueueStore() to avoid a circular
 * import. queueOrdering / getPriorityRank / isTerminalState / linearQuery / fetchActiveIssues are
 * imported directly from their own modules. Injection is safe: configured at runner.ts import time,
 * used only at runtime. The lane→queue-file path helper (laneQueueFile) stays in runner.ts alongside
 * laneLockFile, and the resolved default-lane QUEUE_FILE is injected here, so the lane file-path
 * contract (RUNNER_LANE / SOT-913〜917) is unchanged.
 */
export interface QueueStoreDeps {
  logDir: string;
  queueFile: string;
  historyFile: string;
  maxQueueHistory: number;
  queueItemTtlDays: number;
  log: (tag: string, message: string, context?: Record<string, any>) => void;
}

let deps: QueueStoreDeps | null = null;

export function configureQueueStore(d: QueueStoreDeps): void {
  deps = d;
}

function requireDeps(): QueueStoreDeps {
  if (!deps) {
    throw new Error('queueStore not configured: call configureQueueStore() first');
  }
  return deps;
}

// Read the past-queue history (newest first). Returns [] when the file is
// missing, empty, or unparseable (mirrors loadQueue's defensive behavior).
export function loadQueueHistory(): QueueHistoryItem[] {
  const { historyFile, log } = requireDeps();
  try {
    if (!fs.existsSync(historyFile)) return [];
    const content = fs.readFileSync(historyFile, 'utf8');
    try {
      const history = JSON.parse(content);
      return Array.isArray(history) ? history : [];
    } catch (parseErr: any) {
      log('QUEUE', `loadQueueHistory: JSON parse failed: ${parseErr.message}`);
      return [];
    }
  } catch (err: any) {
    log('QUEUE', `loadQueueHistory ERROR: ${err.message}`);
    return [];
  }
}

// Prepend a dequeued item to the past-queue history (newest first), capped to
// MAX_QUEUE_HISTORY entries. Atomic write; never throws.
export function recordQueueHistory(item: QueueItem): void {
  const { historyFile, maxQueueHistory, log } = requireDeps();
  try {
    const entry: QueueHistoryItem = { ...item, dequeuedAt: new Date().toISOString() };
    const history = loadQueueHistory();
    history.unshift(entry);
    const capped = history.slice(0, maxQueueHistory);
    const tmpFile = historyFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(capped, null, 2));
    fs.renameSync(tmpFile, historyFile);
  } catch (err: any) {
    log('QUEUE', `recordQueueHistory ERROR: ${err.message}`, { issue: item.issueId });
  }
}

export function loadQueue(): QueueItem[] {
  const { queueFile, log } = requireDeps();
  try {
    if (!fs.existsSync(queueFile)) return [];
    const content = fs.readFileSync(queueFile, 'utf8');
    try {
      const queue = JSON.parse(content);
      return Array.isArray(queue) ? queue : [];
    } catch (parseErr: any) {
      const backupFile = queueFile + '.corrupt.' + Date.now();
      try { fs.writeFileSync(backupFile, content); } catch (_) {}
      log('QUEUE', `loadQueue: JSON parse failed, backed up corrupt file to ${path.basename(backupFile)}: ${parseErr.message}`);
      return [];
    }
  } catch (err: any) {
    log('QUEUE', `loadQueue ERROR: ${err.message}`);
    return [];
  }
}

export function normalizeQueue(queue: QueueItem[]): QueueItem[] {
  if (!Array.isArray(queue) || queue.length === 0) return [];

  const map = new Map<string, QueueItem>();
  for (const item of queue) {
    const issueId = item.issueId;
    if (!issueId) continue;

    if (!map.has(issueId)) {
      map.set(issueId, { ...item });
      continue;
    }

    const existing = map.get(issueId)!;

    // Merge retryAt: null (immediate) beats any future time; among two future times, earlier wins
    const existingRetryMs = existing.retryAt ? new Date(existing.retryAt).getTime() : null;
    const newRetryMs = item.retryAt ? new Date(item.retryAt).getTime() : null;
    let mergedRetryAt: string | null;
    if (newRetryMs === null || existingRetryMs === null) {
      mergedRetryAt = null;
    } else {
      mergedRetryAt = new Date(Math.min(existingRetryMs, newRetryMs)).toISOString();
    }

    // priorityRank: take the lower rank value (higher urgency)
    const existingRank = existing.priorityRank ?? getPriorityRank(existing.priority);
    const newRank = item.priorityRank ?? getPriorityRank(item.priority);
    const mergedRank = Math.min(existingRank, newRank);

    // enqueuedAt: take the earlier timestamp
    const existingEnqMs = existing.enqueuedAt ? new Date(existing.enqueuedAt).getTime() : Infinity;
    const newEnqMs = item.enqueuedAt ? new Date(item.enqueuedAt).getTime() : Infinity;
    const mergedEnqueuedAt = existingEnqMs <= newEnqMs ? existing.enqueuedAt : item.enqueuedAt;

    // attemptCount: sum both counts
    const mergedAttemptCount = (existing.attemptCount || 0) + (item.attemptCount || 0);

    // lastAttemptAt: take the later timestamp
    const existingLastMs = existing.lastAttemptAt ? new Date(existing.lastAttemptAt).getTime() : 0;
    const newLastMs = item.lastAttemptAt ? new Date(item.lastAttemptAt).getTime() : 0;
    const mergedLastAttemptAt = existingLastMs >= newLastMs ? existing.lastAttemptAt : item.lastAttemptAt;

    map.set(issueId, {
      ...existing,
      ...item, // keep fields from the latest one by default
      retryAt: mergedRetryAt,
      priorityRank: mergedRank,
      enqueuedAt: mergedEnqueuedAt,
      attemptCount: mergedAttemptCount,
      lastAttemptAt: mergedLastAttemptAt,
      // Restore some fields from existing if they were null in item
      issueIdentifier: item.issueIdentifier || existing.issueIdentifier || null,
      trigger: item.trigger || existing.trigger || null,
      reason: item.reason || existing.reason || null,
      priority: item.priority !== null ? item.priority : existing.priority,
      priorityLabel: item.priorityLabel || existing.priorityLabel || null,
      parentIssueId: item.parentIssueId || existing.parentIssueId || null,
      parentIssueIdentifier: item.parentIssueIdentifier || existing.parentIssueIdentifier || null,
      queueGroup: item.queueGroup || existing.queueGroup || null,
      queueGroupOrder: item.queueGroupOrder || existing.queueGroupOrder || null
    });
  }
  return queueOrdering.sortQueueByPriority(Array.from(map.values()));
}

export async function syncQueueWithLinear(): Promise<void> {
  const { log } = requireDeps();
  const queue = loadQueue();
  if (queue.length === 0) return;

  const toRemove: string[] = [];
  for (const item of queue) {
    try {
      const query = `
        query($id: String!) {
          issue(id: $id) {
            id
            archivedAt
            state { type name }
          }
        }
      `;
      const data: any = await linearQuery(query, { id: item.issueId });

      if (!data.issue) {
        log('QUEUE', `syncQueueWithLinear: removing not-found issue`, { issue: item.issueId });
        toRemove.push(item.issueId);
        continue;
      }

      const { archivedAt, state } = data.issue;

      if (archivedAt) {
        log('QUEUE', `syncQueueWithLinear: removing archived issue`, { issue: item.issueId });
        toRemove.push(item.issueId);
        continue;
      }

      const isTerminal = isTerminalState(state);

      if (isTerminal) {
        log('QUEUE', `syncQueueWithLinear: removing terminal issue state=${state?.name}`, { issue: item.issueId });
        toRemove.push(item.issueId);
      }
    } catch (err: any) {
      // Fail-open: API failure does not remove the item
      log('QUEUE', `syncQueueWithLinear: API error for ${item.issueId}, skipping: ${err.message}`);
    }
  }

  if (toRemove.length > 0) {
    const cleaned = loadQueue().filter(item => !toRemove.includes(item.issueId));
    saveQueue(cleaned);
    log('QUEUE', `syncQueueWithLinear: removed ${toRemove.length} item(s)`, { removed: toRemove.join(',') });
  }
}

/**
 * Refreshes ordering metadata of items already in the local queue from Linear's current state.
 *
 * Priority-only changes in Linear do NOT fire a webhook, so an issue bumped to High/Urgent after
 * it was enqueued would otherwise stay ordered on its stale enqueue-time priority. This re-stamps
 * each queued item's priority and updatedAt with the latest Linear values so the next dequeue()
 * selects by priority first and most-recent update second.
 *
 * Fail-open: on any error (e.g. Linear API failure) the queue is left untouched and execution is
 * never blocked. This only affects selection of the NEXT item — items already running under the
 * lock are not touched.
 */
export async function refreshQueuePriorities(): Promise<void> {
  const { log } = requireDeps();
  try {
    const queue = loadQueue();
    if (queue.length === 0) return;

    const active = await fetchActiveIssues();
    // Key by both identifier and id, since queue items store issueId as either.
    const byKey = new Map<string, { priority: number | null; priorityLabel: string | null; issueUpdatedAt: string | null }>();
    for (const issue of active) {
      const entry = {
        priority: issue.priority ?? null,
        priorityLabel: issue.priorityLabel ?? null,
        issueUpdatedAt: issue.updatedAt ?? null
      };
      if (issue.identifier) byKey.set(issue.identifier, entry);
      if (issue.id) byKey.set(issue.id, entry);
    }

    const changed: string[] = [];
    for (const item of queue) {
      const fresh = item.issueId ? byKey.get(item.issueId) : undefined;
      if (!fresh) continue;
      const newRank = getPriorityRank(fresh.priority);
      const oldRank = item.priorityRank ?? getPriorityRank(item.priority);
      if (newRank !== oldRank || fresh.priority !== item.priority || fresh.issueUpdatedAt !== (item.issueUpdatedAt ?? null)) {
        changed.push(`${item.issueId}:${oldRank}->${newRank}`);
        item.priority = fresh.priority;
        item.priorityLabel = fresh.priorityLabel;
        item.priorityRank = newRank;
        item.issueUpdatedAt = fresh.issueUpdatedAt;
      }
    }

    if (changed.length > 0) {
      saveQueue(queueOrdering.sortQueueByPriority(queue));
      log('QUEUE', `refreshQueuePriorities: updated ${changed.length} item(s)`, { changed: changed.join(',') });
    }
  } catch (err: any) {
    log('QUEUE', `refreshQueuePriorities: error (fail-open, queue unchanged): ${err.message}`);
  }
}

export async function pruneExpiredQueueItems(): Promise<void> {
  const { queueItemTtlDays, log } = requireDeps();
  const queue = loadQueue();
  if (queue.length === 0) return;

  const now = Date.now();
  const ttlMs = queueItemTtlDays * 24 * 60 * 60 * 1000;

  const expired = queue.filter(item => {
    if (!item.enqueuedAt) return false;
    const age = now - new Date(item.enqueuedAt).getTime();
    return age > ttlMs;
  });

  if (expired.length === 0) return;

  const toRemove: string[] = [];
  for (const item of expired) {
    try {
      const query = `
        query($id: String!) {
          issue(id: $id) {
            id
            archivedAt
            state { type name }
          }
        }
      `;
      const data: any = await linearQuery(query, { id: item.issueId });

      if (!data.issue) {
        toRemove.push(item.issueId);
        continue;
      }
      const { archivedAt, state } = data.issue;
      if (archivedAt) {
        toRemove.push(item.issueId);
        continue;
      }
      const isTerminal = isTerminalState(state);
      if (isTerminal) {
        toRemove.push(item.issueId);
      }
      // Active issues older than TTL: keep in queue (do not blindly remove active issues)
    } catch (err: any) {
      log('QUEUE', `pruneExpiredQueueItems: API error for ${item.issueId}, skip: ${err.message}`);
    }
  }

  if (toRemove.length > 0) {
    const cleaned = loadQueue().filter(item => !toRemove.includes(item.issueId));
    saveQueue(cleaned);
    log('QUEUE', `pruneExpiredQueueItems: removed ${toRemove.length} expired item(s)`, { removed: toRemove.join(',') });
  }
}

export function saveQueue(queue: QueueItem[]): void {
  const { logDir, queueFile, log } = requireDeps();
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const tmpFile = queueFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(queue, null, 2));
    fs.renameSync(tmpFile, queueFile);
  } catch (err: any) {
    log('QUEUE', `save ERROR: ${err.message}`);
  }
}

interface EnqueueOptions {
  issueIdentifier?: string | null;
  reason?: string | null;
  priority?: number | null;
  priorityLabel?: string | null;
  parentIssueId?: string | null;
  parentIssueIdentifier?: string | null;
  queueGroup?: string | null;
  queueGroupOrder?: string | null;
}

export function enqueue(issueId: string, trigger: string | null, retryAt: string | null = null, {
  issueIdentifier = null,
  reason = null,
  priority = null,
  priorityLabel = null,
  parentIssueId = null,
  parentIssueIdentifier = null,
  queueGroup = null,
  queueGroupOrder = null
}: EnqueueOptions = {}): void {
  const { log } = requireDeps();
  try {
    // Derive queueGroup from parentIssueId if not explicitly set
    const resolvedQueueGroup = queueGroup ?? (parentIssueId || null);

    const queue = loadQueue();
    const now = new Date().toISOString();
    const existingIndex = queue.findIndex(item => item.issueId === issueId);

    if (existingIndex !== -1) {
      const existing = queue[existingIndex];

      // Merge retryAt: null (immediate) beats any future time; among two future times, earlier wins
      const existingRetryMs = existing.retryAt ? new Date(existing.retryAt).getTime() : null;
      const newRetryMs = retryAt ? new Date(retryAt).getTime() : null;
      let mergedRetryAt: string | null;
      if (newRetryMs === null || existingRetryMs === null) {
        mergedRetryAt = null; // immediate beats any future time
      } else {
        mergedRetryAt = new Date(Math.min(existingRetryMs, newRetryMs)).toISOString();
      }

      queue[existingIndex] = {
        ...existing,
        trigger,
        retryAt: mergedRetryAt,
        lastAttemptAt: now,
        attemptCount: (existing.attemptCount || 0) + 1,
        reason: reason || existing.reason || null,
        ...(issueIdentifier && !existing.issueIdentifier ? { issueIdentifier } : {}),
        // Update priority if provided
        ...(priority !== null ? {
          priority,
          priorityLabel: priorityLabel ?? existing.priorityLabel ?? null,
          priorityRank: getPriorityRank(priority),
          linearFetchedAt: now
        } : {}),
        // Update parent if provided
        ...(parentIssueId !== null ? {
          parentIssueId,
          parentIssueIdentifier: parentIssueIdentifier ?? existing.parentIssueIdentifier ?? null
        } : {}),
        // Update queueGroup if provided or derivable
        ...(resolvedQueueGroup !== null ? {
          queueGroup: resolvedQueueGroup,
          ...(queueGroupOrder !== null ? { queueGroupOrder } : {})
        } : {})
      };
      saveQueue(queueOrdering.sortQueueByPriority(queue));
      log('QUEUE', 'enqueue: updated existing item', { issue: issueId, trigger, retryAt: mergedRetryAt });
      return;
    }

    queue.push({
      issueId,
      issueIdentifier: issueIdentifier || null,
      trigger,
      retryAt,
      enqueuedAt: now,
      lastAttemptAt: null,
      attemptCount: 0,
      reason: reason || null,
      priority: priority !== null ? priority : null,
      priorityLabel: priorityLabel ?? null,
      priorityRank: priority !== null ? getPriorityRank(priority) : getPriorityRank(null),
      linearFetchedAt: priority !== null ? now : null,
      issueUpdatedAt: null,
      parentIssueId: parentIssueId ?? null,
      parentIssueIdentifier: parentIssueIdentifier ?? null,
      queueGroup: resolvedQueueGroup,
      queueGroupOrder: queueGroupOrder ?? null
    });
    saveQueue(queueOrdering.sortQueueByPriority(queue));
    log('QUEUE', 'enqueued', { issue: issueId, trigger });
  } catch (err: any) {
    log('QUEUE', `enqueue ERROR: ${err.message}`, { issue: issueId });
  }
}

export function dequeue(lastProcessedGroup: string | null = null): QueueItem | null {
  const { log } = requireDeps();
  try {
    const queue = loadQueue();
    const now = new Date();

    const bestIndex = queueOrdering.selectNextReadyIndex(queue, { lastProcessedGroup, now });
    if (bestIndex === null) return null;

    const item = queue[bestIndex];
    const rank = queueOrdering.effectiveRank(item);

    // Determine which branch was taken for logging (Urgent > Group > Normal)
    let logType = 'dequeued';
    if (rank === 1) {
      logType = 'dequeued (urgent)';
    } else if (lastProcessedGroup && item.queueGroup === lastProcessedGroup) {
      logType = 'dequeued (group priority)';
    }

    queue.splice(bestIndex, 1);
    saveQueue(queue);
    recordQueueHistory(item);

    if (logType === 'dequeued (group priority)') {
      log('QUEUE', logType, { issue: item.issueId, queueGroup: item.queueGroup, priorityRank: rank });
    } else {
      log('QUEUE', logType, { issue: item.issueId, priorityRank: rank });
    }

    return item;
  } catch (err: any) {
    log('QUEUE', `dequeue ERROR: ${err.message}`);
    return null;
  }
}

export function removeFromQueue(issueId: string): void {
  const { log } = requireDeps();
  try {
    const queue = loadQueue();
    const filtered = queue.filter(item => item.issueId !== issueId);
    if (filtered.length !== queue.length) {
      saveQueue(filtered);
      log('QUEUE', 'removed', { issue: issueId });
    }
  } catch (err: any) {
    log('QUEUE', `removeFromQueue ERROR: ${err.message}`, { issue: issueId });
  }
}

export function isQueued(issueId: string): boolean {
  const queue = loadQueue();
  return queue.some(item => item.issueId === issueId);
}
