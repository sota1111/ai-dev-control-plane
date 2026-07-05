import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyWorkerFailure,
  isChronic,
  authUnhealthyFile,
  readAuthUnhealthy,
  writeAuthUnhealthy,
  clearAuthUnhealthy,
  shouldSkipForAuthUnhealthy,
} from '../lib/workerHealth.js';

// SOT-1441 / P1 — worker availability classification + auth-unhealthy marker.
describe('workerHealth', () => {
  describe('classifyWorkerFailure', () => {
    test('exit 0 → ok', () => {
      expect(classifyWorkerFailure('anything', 0)).toBe('ok');
    });
    test('Antigravity auth failure text → auth_failure (chronic)', () => {
      expect(classifyWorkerFailure('Error: authentication failed or timed out', 1)).toBe('auth_failure');
      expect(isChronic('auth_failure')).toBe(true);
    });
    test('usage-limit text → usage_limit (transient, wins over auth wording)', () => {
      expect(classifyWorkerFailure('You have hit your usage limit, try again at 5pm', 1)).toBe('usage_limit');
      expect(isChronic('usage_limit')).toBe(false);
    });
    test('exit 124 with no known text → timeout', () => {
      expect(classifyWorkerFailure('killed', 124)).toBe('timeout');
    });
    test('other non-zero exit → crash', () => {
      expect(classifyWorkerFailure('segfault', 139)).toBe('crash');
    });
    test('not logged in / unauthorized → auth_failure', () => {
      expect(classifyWorkerFailure('please log in to continue', 1)).toBe('auth_failure');
      expect(classifyWorkerFailure('401 Unauthorized', 1)).toBe('auth_failure');
    });
  });

  describe('auth-unhealthy marker', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-'));
    });
    afterEach(() => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('write then read reports active within TTL', () => {
      const now = 1_000_000_000_000; // fixed ms
      writeAuthUnhealthy('antigravity', dir, 900, now);
      expect(fs.existsSync(authUnhealthyFile('antigravity', dir))).toBe(true);
      const status = readAuthUnhealthy('antigravity', dir, now + 60_000); // 1m later
      expect(status.active).toBe(true);
      expect(status.remainingSeconds).toBe(900 - 60);
    });

    test('marker is inactive after TTL expires', () => {
      const now = 1_000_000_000_000;
      writeAuthUnhealthy('codex', dir, 10, now); // 10s TTL
      const status = readAuthUnhealthy('codex', dir, now + 11_000); // 11s later
      expect(status.active).toBe(false);
    });

    test('missing marker → inactive', () => {
      expect(readAuthUnhealthy('codex', dir).active).toBe(false);
    });

    test('clearAuthUnhealthy removes the marker', () => {
      const now = 1_000_000_000_000;
      writeAuthUnhealthy('antigravity', dir, 900, now);
      clearAuthUnhealthy('antigravity', dir);
      expect(fs.existsSync(authUnhealthyFile('antigravity', dir))).toBe(false);
      expect(readAuthUnhealthy('antigravity', dir, now).active).toBe(false);
    });
  });

  // SOT-1548 — the pre-run gate decision used by run_antigravity.sh. Reader and writer must agree so a
  // fresh marker can never slip through and pay the ~40s agy auth probe (the SOT-1533 hole).
  describe('shouldSkipForAuthUnhealthy (pre-run gate)', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-gate-'));
    });
    afterEach(() => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('marker written by writeAuthUnhealthy reads as fresh → skip (round-trip, no drift)', () => {
      const now = 1_000_000_000_000;
      writeAuthUnhealthy('antigravity', dir, 900, now);
      expect(shouldSkipForAuthUnhealthy('antigravity', dir, now + 60_000)).toBe(true);
    });

    test('marker expired → do NOT skip (retry agy as before)', () => {
      const now = 1_000_000_000_000;
      writeAuthUnhealthy('antigravity', dir, 10, now);
      expect(shouldSkipForAuthUnhealthy('antigravity', dir, now + 11_000)).toBe(false);
    });

    test('missing marker → do NOT skip', () => {
      expect(shouldSkipForAuthUnhealthy('antigravity', dir)).toBe(false);
    });

    test('malformed marker JSON → do NOT skip (fail-open to launching)', () => {
      fs.writeFileSync(authUnhealthyFile('antigravity', dir), '{ not valid json');
      expect(shouldSkipForAuthUnhealthy('antigravity', dir)).toBe(false);
    });

    test('marker without expiresAtEpoch → do NOT skip', () => {
      fs.writeFileSync(authUnhealthyFile('antigravity', dir), JSON.stringify({ detectedAt: 'x' }));
      expect(shouldSkipForAuthUnhealthy('antigravity', dir)).toBe(false);
    });
  });
});
