import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  backoffMs,
  shouldSuppressReaperEnqueue,
  nextEligibleAt,
  loadEntries,
  getEntry,
  recordHumanWait,
  clearHumanWait,
  type HumanWaitEntry,
  type SuppressionPolicy,
} from '../lib/reaperSuppression.js';

const POLICY: SuppressionPolicy = { baseMs: 30 * 60 * 1000, maxMs: 6 * 60 * 60 * 1000, maxRetries: 3 };

describe('reaperSuppression — backoffMs', () => {
  it('grows exponentially from baseMs and caps at maxMs', () => {
    expect(backoffMs(1, POLICY)).toBe(30 * 60 * 1000); // 30m
    expect(backoffMs(2, POLICY)).toBe(60 * 60 * 1000); // 1h
    expect(backoffMs(3, POLICY)).toBe(2 * 60 * 60 * 1000); // 2h
    expect(backoffMs(4, POLICY)).toBe(4 * 60 * 60 * 1000); // 4h
    expect(backoffMs(5, POLICY)).toBe(6 * 60 * 60 * 1000); // 8h -> capped at 6h
    expect(backoffMs(50, POLICY)).toBe(6 * 60 * 60 * 1000); // no overflow, still capped
  });
});

describe('reaperSuppression — shouldSuppressReaperEnqueue', () => {
  const now = Date.parse('2026-07-05T12:00:00.000Z');

  it('does not suppress when there is no entry', () => {
    expect(shouldSuppressReaperEnqueue(undefined, now, POLICY)).toBe(false);
    expect(shouldSuppressReaperEnqueue(null, now, POLICY)).toBe(false);
  });

  it('suppresses while inside the backoff window', () => {
    const entry: HumanWaitEntry = { issueId: 'SOT-1', count: 1, lastAt: new Date(now - 10 * 60 * 1000).toISOString() };
    // 10 min since last, backoff for count=1 is 30 min -> still suppressed
    expect(shouldSuppressReaperEnqueue(entry, now, POLICY)).toBe(true);
  });

  it('allows a backed-off retry once the window elapses', () => {
    const entry: HumanWaitEntry = { issueId: 'SOT-1', count: 1, lastAt: new Date(now - 31 * 60 * 1000).toISOString() };
    // 31 min since last, backoff for count=1 is 30 min -> eligible again
    expect(shouldSuppressReaperEnqueue(entry, now, POLICY)).toBe(false);
  });

  it('suppresses indefinitely once retries are exhausted (count > maxRetries)', () => {
    const entry: HumanWaitEntry = { issueId: 'SOT-1', count: 4, lastAt: new Date(now - 100 * 60 * 60 * 1000).toISOString() };
    // Way past any backoff window, but count(4) > maxRetries(3) -> still suppressed until human input
    expect(shouldSuppressReaperEnqueue(entry, now, POLICY)).toBe(true);
  });

  it('maxRetries=0 suppresses immediately after the first code=70', () => {
    const policy: SuppressionPolicy = { ...POLICY, maxRetries: 0 };
    const entry: HumanWaitEntry = { issueId: 'SOT-1', count: 1, lastAt: new Date(now - 999 * 60 * 60 * 1000).toISOString() };
    expect(shouldSuppressReaperEnqueue(entry, now, policy)).toBe(true);
  });

  it('fails open on an unparseable timestamp', () => {
    const entry: HumanWaitEntry = { issueId: 'SOT-1', count: 1, lastAt: 'not-a-date' };
    expect(shouldSuppressReaperEnqueue(entry, now, POLICY)).toBe(false);
  });
});

describe('reaperSuppression — nextEligibleAt', () => {
  it('reports human-input once retries are exhausted', () => {
    const entry: HumanWaitEntry = { issueId: 'SOT-1', count: 4, lastAt: '2026-07-05T12:00:00.000Z' };
    expect(nextEligibleAt(entry, POLICY)).toBe('human-input');
  });

  it('reports the backoff-end ISO time within the retry budget', () => {
    const entry: HumanWaitEntry = { issueId: 'SOT-1', count: 1, lastAt: '2026-07-05T12:00:00.000Z' };
    expect(nextEligibleAt(entry, POLICY)).toBe('2026-07-05T12:30:00.000Z');
  });
});

describe('reaperSuppression — durable store', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-suppress-'));
    file = path.join(dir, 'nested', 'runner.humanwait-suppress.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('record increments count and persists (creating the dir)', () => {
    const first = recordHumanWait(file, 'SOT-1531', new Date('2026-07-05T12:00:00.000Z'));
    expect(first).toEqual({ issueId: 'SOT-1531', count: 1, lastAt: '2026-07-05T12:00:00.000Z' });
    expect(fs.existsSync(file)).toBe(true);

    const second = recordHumanWait(file, 'SOT-1531', new Date('2026-07-05T13:00:00.000Z'));
    expect(second.count).toBe(2);
    expect(second.lastAt).toBe('2026-07-05T13:00:00.000Z');

    expect(getEntry(file, 'SOT-1531')?.count).toBe(2);
  });

  it('tracks issues independently', () => {
    recordHumanWait(file, 'SOT-1');
    recordHumanWait(file, 'SOT-2');
    recordHumanWait(file, 'SOT-2');
    expect(getEntry(file, 'SOT-1')?.count).toBe(1);
    expect(getEntry(file, 'SOT-2')?.count).toBe(2);
  });

  it('clear removes an entry and reports whether one existed', () => {
    recordHumanWait(file, 'SOT-1531');
    expect(clearHumanWait(file, 'SOT-1531')).toBe(true);
    expect(getEntry(file, 'SOT-1531')).toBeUndefined();
    // Idempotent: clearing again reports false.
    expect(clearHumanWait(file, 'SOT-1531')).toBe(false);
  });

  it('loadEntries is fail-open on a missing or corrupt file', () => {
    expect(loadEntries(path.join(dir, 'does-not-exist.json'))).toEqual({});
    fs.writeFileSync(file.replace(/nested\//, ''), 'not json{');
    expect(loadEntries(file.replace(/nested\//, ''))).toEqual({});
  });

  it('record then clear on human input makes the issue eligible again', () => {
    const now = Date.now();
    recordHumanWait(file, 'SOT-1531', new Date(now));
    expect(shouldSuppressReaperEnqueue(getEntry(file, 'SOT-1531'), now, POLICY)).toBe(true);
    clearHumanWait(file, 'SOT-1531'); // simulate a human comment / state change
    expect(shouldSuppressReaperEnqueue(getEntry(file, 'SOT-1531'), now, POLICY)).toBe(false);
  });
});
