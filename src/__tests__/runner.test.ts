import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

const mockFs = {
  appendFileSync: jest.fn(),
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(() => []),
  renameSync: jest.fn(),
  unlinkSync: jest.fn(),
  writeFileSync: jest.fn(),
};
const mockHttps = { request: jest.fn() };
const mockCp = { spawn: jest.fn(), execSync: jest.fn() };

jest.unstable_mockModule('node:fs', () => ({ ...mockFs, default: mockFs }));
jest.unstable_mockModule('node:https', () => ({ ...mockHttps, default: mockHttps }));
jest.unstable_mockModule('node:child_process', () => ({ ...mockCp, default: mockCp }));

const fs: any = mockFs;
const https: any = mockHttps;
const { spawn } = mockCp;
const runner: any = await import('../runner.js');

describe('runner', () => {
  const mockLockFile = runner.LOCK_FILE;
  let prevRunnerStableMode: string | undefined;

  beforeEach(() => {
    prevRunnerStableMode = process.env.RUNNER_STABLE_MODE;
    delete process.env.RUNNER_STABLE_MODE;
    jest.clearAllMocks();
    jest.spyOn(process, 'kill').mockImplementation(() => true);
    // Default mock for existsSync
    fs.existsSync.mockReturnValue(false);
    runner.setRunnerPausedState(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (prevRunnerStableMode === undefined) delete process.env.RUNNER_STABLE_MODE;
    else process.env.RUNNER_STABLE_MODE = prevRunnerStableMode;
  });

  describe('lane resolution (SOT-913)', () => {
    it('default lane keeps the historical lock/queue paths', () => {
      expect(runner.LOCK_FILE.endsWith('runner.lock')).toBe(true);
      expect(runner.QUEUE_FILE.endsWith('runner.queue.json')).toBe(true);
      expect(runner.resolveLane()).toBe(runner.DEFAULT_LANE);
      expect(runner.resolveLane('')).toBe(runner.DEFAULT_LANE);
      expect(runner.resolveLane('default')).toBe(runner.DEFAULT_LANE);
      expect(runner.laneLockFile()).toBe(runner.LOCK_FILE);
      expect(runner.laneQueueFile()).toBe(runner.QUEUE_FILE);
    });

    it('non-default lane produces independent lock/queue paths', () => {
      const lockSim = runner.laneLockFile('sim');
      const queueSim = runner.laneQueueFile('sim');
      expect(lockSim.endsWith('runner.sim.lock')).toBe(true);
      expect(queueSim.endsWith('runner.sim.queue.json')).toBe(true);
      expect(lockSim).not.toBe(runner.LOCK_FILE);
      expect(queueSim).not.toBe(runner.QUEUE_FILE);
      expect(lockSim.startsWith(runner.LOG_DIR)).toBe(true);
    });

    it('reads the lane from an env object via RUNNER_LANE', () => {
      expect(runner.resolveLane({ RUNNER_LANE: 'fast' })).toBe('fast');
      expect(runner.resolveLane({})).toBe(runner.DEFAULT_LANE);
    });

    it('sanitizes the lane so it cannot escape LOG_DIR', () => {
      // '../evil' → non [a-zA-Z0-9_-] chars stripped → 'evil', stays inside LOG_DIR
      expect(runner.resolveLane('../evil')).toBe('evil');
      const lock = runner.laneLockFile('../evil');
      expect(lock.startsWith(runner.LOG_DIR)).toBe(true);
      expect(lock.includes('..')).toBe(false);
    });
  });

  describe('serialization scope switch (SOT-931, 案A)', () => {
    it('defaults to repo scope when RUNNER_SERIALIZE_SCOPE is unset/unknown', () => {
      expect(runner.resolveSerializeScope({})).toBe(runner.SERIALIZE_SCOPE_REPO);
      expect(runner.resolveSerializeScope({ RUNNER_SERIALIZE_SCOPE: '' })).toBe(runner.SERIALIZE_SCOPE_REPO);
      expect(runner.resolveSerializeScope({ RUNNER_SERIALIZE_SCOPE: 'nonsense' })).toBe(runner.SERIALIZE_SCOPE_REPO);
      // explicit repo / branch (case-insensitive, trimmed)
      expect(runner.resolveSerializeScope({ RUNNER_SERIALIZE_SCOPE: 'repo' })).toBe(runner.SERIALIZE_SCOPE_REPO);
      expect(runner.resolveSerializeScope({ RUNNER_SERIALIZE_SCOPE: '  Branch ' })).toBe(runner.SERIALIZE_SCOPE_BRANCH);
    });

    it('repo scope: all branches of one repo share the same lane (直列)', () => {
      const a = runner.serializationLaneKey({ repo: 'booking-monitor', branch: 'feat/a', scope: 'repo' });
      const b = runner.serializationLaneKey({ repo: 'booking-monitor', branch: 'feat/b', scope: 'repo' });
      expect(a).toBe('booking-monitor');
      expect(a).toBe(b); // same lane → serialized
    });

    it('branch scope: different branches get independent lanes (並行可), same branch shares a lane (直列)', () => {
      const a = runner.serializationLaneKey({ repo: 'booking-monitor', branch: 'feat/a', scope: 'branch' });
      const b = runner.serializationLaneKey({ repo: 'booking-monitor', branch: 'feat/b', scope: 'branch' });
      const a2 = runner.serializationLaneKey({ repo: 'booking-monitor', branch: 'feat/a', scope: 'branch' });
      expect(a).not.toBe(b);            // 別 branch → 別 lane
      expect(a).toBe(a2);               // 同一 branch → 同一 lane
      expect(a.startsWith('booking-monitor')).toBe(true);
    });

    it('unknown/empty repo maps to DEFAULT_LANE under either scope', () => {
      expect(runner.serializationLaneKey({ repo: '', branch: 'x', scope: 'branch' })).toBe(runner.DEFAULT_LANE);
      expect(runner.serializationLaneKey({ scope: 'repo' })).toBe(runner.DEFAULT_LANE);
    });

    it('branch-scope lane key stays lane-safe (cannot escape LOG_DIR)', () => {
      const key = runner.serializationLaneKey({ repo: '../evil', branch: '../../x', scope: 'branch' });
      const lock = runner.laneLockFile(key);
      expect(key.includes('/')).toBe(false);
      expect(key.includes('..')).toBe(false);
      expect(lock.startsWith(runner.LOG_DIR)).toBe(true);
    });

    it('explicit RUNNER_LANE always wins over scope derivation (backward compat)', () => {
      const lane = runner.resolveLane({
        RUNNER_LANE: 'sim',
        RUNNER_SERIALIZE_SCOPE: 'branch',
        RUNNER_REPO: 'booking-monitor',
        RUNNER_BRANCH: 'feat/a'
      });
      expect(lane).toBe('sim');
    });

    it('branch scope derives lane from RUNNER_REPO/RUNNER_BRANCH when no explicit lane', () => {
      const lane = runner.resolveLane({
        RUNNER_SERIALIZE_SCOPE: 'branch',
        RUNNER_REPO: 'booking-monitor',
        RUNNER_BRANCH: 'feat/a'
      });
      expect(lane).toBe('booking-monitor--feata');
      // distinct branch → distinct lane → distinct lock/queue files
      const other = runner.resolveLane({
        RUNNER_SERIALIZE_SCOPE: 'branch',
        RUNNER_REPO: 'booking-monitor',
        RUNNER_BRANCH: 'feat/b'
      });
      expect(runner.laneLockFile(lane)).not.toBe(runner.laneLockFile(other));
    });

    it('repo scope (default) keeps DEFAULT_LANE even with RUNNER_REPO/RUNNER_BRANCH set', () => {
      const lane = runner.resolveLane({
        RUNNER_REPO: 'booking-monitor',
        RUNNER_BRANCH: 'feat/a'
      });
      expect(lane).toBe(runner.DEFAULT_LANE);
      expect(runner.laneLockFile(lane)).toBe(runner.LOCK_FILE);
    });
  });

  describe('worktree isolation opt-in (SOT-1559 reopen)', () => {
    it('resolveWorktreeIsolation is off by default and parses truthy values', () => {
      expect(runner.resolveWorktreeIsolation({})).toBe(false);
      expect(runner.resolveWorktreeIsolation({ RUNNER_WORKTREE_ISOLATION: '' })).toBe(false);
      expect(runner.resolveWorktreeIsolation({ RUNNER_WORKTREE_ISOLATION: '0' })).toBe(false);
      for (const v of ['1', 'true', 'yes', 'on', ' TRUE ', 'On']) {
        expect(runner.resolveWorktreeIsolation({ RUNNER_WORKTREE_ISOLATION: v })).toBe(true);
      }
    });

    it('repo scope + isolation ON: default-lane run gets a per-issue iso worktree lane', () => {
      const lane = runner.resolveWorktreeLane(
        { RUNNER_WORKTREE_ISOLATION: '1' },
        'SOT-1559'
      );
      expect(lane).toBe('iso-SOT-1559');
      // the serialization lane itself stays DEFAULT (locks/queue unchanged → 同一 repo 直列)
      expect(runner.resolveLane({ RUNNER_WORKTREE_ISOLATION: '1' })).toBe(runner.DEFAULT_LANE);
    });

    it('repo scope + isolation OFF: no worktree (backward compatible; scope≠branch → not used)', () => {
      expect(runner.resolveWorktreeLane({}, 'SOT-1559')).toBe(runner.DEFAULT_LANE);
      // even with RUNNER_REPO/BRANCH set under repo scope, no worktree without the flag
      expect(
        runner.resolveWorktreeLane(
          { RUNNER_REPO: 'ai-dev-control-plane', RUNNER_BRANCH: 'feat/x' },
          'SOT-1559'
        )
      ).toBe(runner.DEFAULT_LANE);
    });

    it('isolation ON but no issue id → no iso lane (nothing to key on)', () => {
      expect(runner.resolveWorktreeLane({ RUNNER_WORKTREE_ISOLATION: '1' }, '')).toBe(runner.DEFAULT_LANE);
      expect(runner.resolveWorktreeLane({ RUNNER_WORKTREE_ISOLATION: '1' }, null)).toBe(runner.DEFAULT_LANE);
    });

    it('branch scope is unchanged: non-default serialization lane wins over iso (no regression)', () => {
      const env = {
        RUNNER_SERIALIZE_SCOPE: 'branch',
        RUNNER_REPO: 'booking-monitor',
        RUNNER_BRANCH: 'feat/a',
        RUNNER_WORKTREE_ISOLATION: '1'
      };
      // base serialization lane is non-default → worktree lane == serialization lane (SOT-932 behavior)
      expect(runner.resolveWorktreeLane(env, 'SOT-1559')).toBe('booking-monitor--feata');
      // worktreeLaneFor honors an explicit non-default base lane and ignores the iso fallback
      expect(runner.worktreeLaneFor('booking-monitor--feata', 'SOT-1559', env)).toBe('booking-monitor--feata');
    });

    it('iso worktree lane stays lane-safe (cannot escape the worktree base dir)', () => {
      const lane = runner.resolveWorktreeLane({ RUNNER_WORKTREE_ISOLATION: '1' }, '../../evil/../id');
      expect(lane.includes('/')).toBe(false);
      expect(lane.includes('..')).toBe(false);
      expect(lane.startsWith('iso-')).toBe(true);
    });
  });

  describe('acquireLock', () => {
    it('returns true when lock file does not exist', () => {
      fs.existsSync.mockImplementation((path: string) => path === runner.LOG_DIR); // log dir exists, lock file doesn't
      const result = runner.acquireLock();
      expect(result).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalledWith(mockLockFile, expect.stringContaining(process.pid.toString()));
    });

    it('returns false when lock is held by a live process', () => {
      fs.existsSync.mockImplementation(() => true);
      fs.readFileSync.mockReturnValue(`${process.pid + 1}:${new Date().toISOString()}`);
      
      const result = runner.acquireLock();
      expect(result).toBe(false);
    });

    it('returns true and removes stale lock when process is dead', () => {
      fs.existsSync.mockImplementation(() => true);
      fs.readFileSync.mockReturnValue(`99999:${new Date().toISOString()}`);
      (process.kill as jest.Mock).mockImplementation(() => {
        const err: any = new Error('Process not found');
        err.code = 'ESRCH';
        throw err;
      });

      const result = runner.acquireLock();
      expect(result).toBe(true);
      expect(fs.unlinkSync).toHaveBeenCalledWith(mockLockFile);
      expect(fs.writeFileSync).toHaveBeenCalledWith(mockLockFile, expect.stringContaining(process.pid.toString()));
    });

    it('returns true and removes old stale lock (age > STALE_LOCK_MS)', () => {
      fs.existsSync.mockImplementation(() => true);
      const oldDate = new Date(Date.now() - runner.STALE_LOCK_MS - 1000).toISOString();
      fs.readFileSync.mockReturnValue(`${process.pid + 1}:${oldDate}`);

      const result = runner.acquireLock();
      expect(result).toBe(true);
      expect(fs.unlinkSync).toHaveBeenCalledWith(mockLockFile);
    });
  });

  describe('releaseLock', () => {
    it('deletes the lock file if it belongs to current pid', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(`${process.pid}:${new Date().toISOString()}`);
      
      runner.releaseLock();
      expect(fs.unlinkSync).toHaveBeenCalledWith(mockLockFile);
    });

    it('does not delete the lock file if it belongs to another pid', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(`${process.pid + 1}:${new Date().toISOString()}`);
      
      runner.releaseLock();
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe('usage limit cooldown', () => {
    it('setUsageLimitCooldownUntil() writes cooldown JSON atomically', () => {
      fs.existsSync.mockReturnValue(true);
      const retryAt = new Date(Date.now() + 600000).toISOString();

      runner.setUsageLimitCooldownUntil(retryAt);

      // Should write to both COOLDOWN_FILE and USAGE_LIMIT_FILE
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.cooldown.json.tmp'),
        expect.stringContaining(retryAt)
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.usage-limit.json.tmp'),
        JSON.stringify({ retryAt, issueId: null }, null, 2)
      );
      expect(fs.renameSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.cooldown.json.tmp'),
        runner.COOLDOWN_FILE
      );
      expect(fs.renameSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.usage-limit.json.tmp'),
        runner.USAGE_LIMIT_FILE
      );
    });

    it('getUsageLimitCooldownUntil() returns a future cooldown', () => {
      const retryAt = new Date(Date.now() + 600000).toISOString();
      // Mock COOLDOWN_FILE exists
      fs.existsSync.mockImplementation((path: string) => path === runner.COOLDOWN_FILE);
      fs.readFileSync.mockReturnValue(JSON.stringify({ until: retryAt }));

      expect(runner.getUsageLimitCooldownUntil()).toEqual({
        retryAt,
        issueId: null,
        issueIdentifier: null,
        reason: null,
        limitType: null,
        active: true
      });
    });

    it('getUsageLimitCooldownUntil() clears expired cooldowns', () => {
      const retryAt = new Date(Date.now() - 1000).toISOString();
      fs.existsSync.mockImplementation((path: string) => 
        path === runner.COOLDOWN_FILE || path === runner.USAGE_LIMIT_FILE
      );
      fs.readFileSync.mockReturnValue(JSON.stringify({ until: retryAt }));

      expect(runner.getUsageLimitCooldownUntil()).toBe(null);
      expect(fs.unlinkSync).toHaveBeenCalledWith(runner.COOLDOWN_FILE);
      expect(fs.unlinkSync).toHaveBeenCalledWith(runner.USAGE_LIMIT_FILE);
    });
  });


  describe('queue history (past queue)', () => {
    function historyWrites() {
      return (fs.writeFileSync as jest.Mock).mock.calls
        .filter((c: any[]) => String(c[0]) === `${runner.HISTORY_FILE}.tmp`);
    }

    it('loadQueueHistory() returns [] when the history file is missing', () => {
      fs.existsSync.mockReturnValue(false);
      expect(runner.loadQueueHistory()).toEqual([]);
    });

    it('recordQueueHistory() prepends newest-first with a dequeuedAt and writes atomically', () => {
      fs.existsSync.mockImplementation((p: string) => p === runner.HISTORY_FILE);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-OLD', dequeuedAt: '2026-01-01T00:00:00.000Z' }]));

      runner.recordQueueHistory({ issueId: 'SOT-NEW', issueIdentifier: 'SOT-NEW' });

      const lastWrite = historyWrites().pop();
      expect(lastWrite).toBeDefined();
      const saved = JSON.parse(lastWrite![1] as string);
      expect(saved[0].issueId).toBe('SOT-NEW');
      expect(saved[0].dequeuedAt).toEqual(expect.any(String));
      expect(saved[1].issueId).toBe('SOT-OLD');
      expect(fs.renameSync).toHaveBeenCalledWith(`${runner.HISTORY_FILE}.tmp`, runner.HISTORY_FILE);
    });

    it('recordQueueHistory() caps the history at MAX_QUEUE_HISTORY entries', () => {
      const existing = Array.from({ length: runner.MAX_QUEUE_HISTORY }, (_, i) => ({ issueId: `SOT-${i}` }));
      fs.existsSync.mockImplementation((p: string) => p === runner.HISTORY_FILE);
      fs.readFileSync.mockReturnValue(JSON.stringify(existing));

      runner.recordQueueHistory({ issueId: 'SOT-NEWEST' });

      const saved = JSON.parse((historyWrites().pop()![1]) as string);
      expect(saved.length).toBe(runner.MAX_QUEUE_HISTORY);
      expect(saved[0].issueId).toBe('SOT-NEWEST');
      expect(saved.some((i: any) => i.issueId === `SOT-${runner.MAX_QUEUE_HISTORY - 1}`)).toBe(false);
    });

    it('dequeue() records the dequeued item into history', () => {
      const queue = [{ issueId: 'SOT-D1', trigger: 'webhook', retryAt: null }];
      fs.existsSync.mockImplementation((p: string) => p === runner.QUEUE_FILE);
      fs.readFileSync.mockImplementation((p: string) => (p === runner.QUEUE_FILE ? JSON.stringify(queue) : ''));

      const item = runner.dequeue();
      expect(item.issueId).toBe('SOT-D1');

      const lastWrite = historyWrites().pop();
      expect(lastWrite).toBeDefined();
      expect(String(lastWrite![1])).toContain('SOT-D1');
      expect(String(lastWrite![1])).toContain('dequeuedAt');
    });
  });

  describe('queue management', () => {
    function setupQueueState(initialQueue: any[], { lockHeld = false } = {}) {
      let currentQueue = initialQueue.map(item => ({ ...item }));

      fs.existsSync.mockImplementation((path: string) => (
        path === runner.LOG_DIR
        || path === runner.QUEUE_FILE
        || (lockHeld && path === runner.LOCK_FILE)
      ));
      fs.readFileSync.mockImplementation((path: string) => {
        if (path === runner.QUEUE_FILE) return JSON.stringify(currentQueue);
        if (path === runner.LOCK_FILE) return `${process.pid + 1}:${new Date().toISOString()}`;
        return '';
      });
      fs.writeFileSync.mockImplementation((path: string, content: string) => {
        if (path === `${runner.QUEUE_FILE}.tmp`) {
          currentQueue = JSON.parse(content);
        }
      });

      return {
        getQueue: () => currentQueue.map(item => ({ ...item }))
      };
    }

    function queueItem(issueId: string, priority: number | null | undefined, extra: any = {}) {
      return {
        issueId,
        trigger: 'webhook',
        retryAt: null,
        enqueuedAt: extra.enqueuedAt || `2026-06-16T00:0${issueId.slice(-1)}:00.000Z`,
        priority,
        priorityRank: runner.getPriorityRank(priority),
        ...extra
      };
    }

    function mockRunAutoExit(code: number, output = '') {
      (spawn as jest.Mock).mockImplementation(() => {
        const child: any = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 12345;
        process.nextTick(() => {
          if (output) child.stdout.emit('data', Buffer.from(output));
          child.emit('close', code, null);
        });
        return child;
      });
    }

    it('enqueue() adds item to queue JSON file', () => {
      fs.existsSync.mockReturnValue(false); // queue file doesn't exist
      runner.enqueue('SOT-123', 'webhook');
      
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.queue.json.tmp'),
        expect.stringContaining('SOT-123')
      );
      expect(fs.renameSync).toHaveBeenCalled();
    });

    it('enqueue() updates existing item instead of skipping', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-123', trigger: 'webhook' }]));
      
      runner.enqueue('SOT-123', 'manual');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.queue.json.tmp'),
        expect.stringContaining('"trigger": "manual"')
      );
    });

    it('enqueue() is idempotent: same id twice yields a single queue entry (later priority wins)', () => {
      // Simulates bootstrap scan having enqueued the issue, then a webhook re-enqueuing it.
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { issueId: 'SOT-123', trigger: 'webhook-bootstrap', priority: 3, priorityRank: 3 }
      ]));

      runner.enqueue('SOT-123', 'webhook', null, { priority: 1, priorityLabel: 'Urgent' });

      const lastWrite = (fs.writeFileSync as jest.Mock).mock.calls
        .filter((c: any[]) => String(c[0]).includes('runner.queue.json.tmp'))
        .pop();
      const saved = JSON.parse(lastWrite![1] as string);
      expect(saved.filter((i: any) => i.issueId === 'SOT-123').length).toBe(1);
      expect(saved.find((i: any) => i.issueId === 'SOT-123').priority).toBe(1);
    });

    it('dequeue() returns first ready item (retryAt=null)', () => {
      const queue = [
        { issueId: 'SOT-1', trigger: 'webhook', retryAt: null },
        { issueId: 'SOT-2', trigger: 'webhook', retryAt: null }
      ];
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(queue));
      
      const item = runner.dequeue();
      expect(item.issueId).toBe('SOT-1');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.queue.json.tmp'),
        expect.not.stringContaining('SOT-1')
      );
    });

    it('priority 1 is dequeued first among priority 1, 2, and 3', () => {
      setupQueueState([
        queueItem('SOT-102', 2),
        queueItem('SOT-103', 3),
        queueItem('SOT-101', 1)
      ]);

      expect(runner.dequeue().issueId).toBe('SOT-101');
    });

    it('priority 2 is dequeued before priority 3', () => {
      setupQueueState([
        queueItem('SOT-103', 3),
        queueItem('SOT-102', 2)
      ]);

      expect(runner.dequeue().issueId).toBe('SOT-102');
    });

    it('priority 4 is dequeued before priority 0', () => {
      setupQueueState([
        queueItem('SOT-100', 0),
        queueItem('SOT-104', 4)
      ]);

      expect(runner.dequeue().issueId).toBe('SOT-104');
    });

    it('priority 0 is treated as No priority and goes last', () => {
      setupQueueState([
        queueItem('SOT-100', 0),
        queueItem('SOT-103', 3),
        queueItem('SOT-104', 4)
      ]);

      expect(runner.dequeue().issueId).toBe('SOT-103');
      expect(runner.dequeue().issueId).toBe('SOT-104');
      expect(runner.dequeue().issueId).toBe('SOT-100');
    });

    it('priority null and undefined are treated as No priority and go last', () => {
      setupQueueState([
        queueItem('SOT-110', null),
        queueItem('SOT-102', 2),
        queueItem('SOT-111', undefined, { priorityRank: undefined })
      ]);

      expect(runner.dequeue().issueId).toBe('SOT-102');
      expect(runner.dequeue().issueId).toBe('SOT-110');
      expect(runner.dequeue().issueId).toBe('SOT-111');
    });

    it('does not treat priority 0 as the first item in simple ascending priority order', () => {
      setupQueueState([
        queueItem('SOT-100', 0),
        queueItem('SOT-101', 1),
        queueItem('SOT-102', 2),
        queueItem('SOT-103', 3),
        queueItem('SOT-104', 4)
      ]);

      expect(runner.dequeue().issueId).toBe('SOT-101');
    });

    it('skips future retryAt priority 1 item and dequeues ready priority 2 item first', () => {
      const future = new Date(Date.now() + 3600000).toISOString();
      setupQueueState([
        queueItem('SOT-101', 1, { retryAt: future }),
        queueItem('SOT-102', 2)
      ]);

      expect(runner.dequeue().issueId).toBe('SOT-102');
    });

    it('dequeues child issue immediately after its parent issue', () => {
      setupQueueState([
        queueItem('SOT-201', 1),
        queueItem('SOT-301', 2),
        queueItem('SOT-202', 4, {
          parentIssueId: 'SOT-201',
          parentIssueIdentifier: 'SOT-201',
          queueGroup: 'SOT-201'
        })
      ]);

      const parent = runner.dequeue();
      const child = runner.dequeue(parent.issueId);

      expect(parent.issueId).toBe('SOT-201');
      expect(child.issueId).toBe('SOT-202');
    });

    it('dequeues multiple child issues by priorityRank within the same parent group', () => {
      setupQueueState([
        queueItem('SOT-201', 1),
        queueItem('SOT-202', 4, { queueGroup: 'SOT-201', parentIssueId: 'SOT-201' }),
        queueItem('SOT-203', 2, { queueGroup: 'SOT-201', parentIssueId: 'SOT-201' })
      ]);

      const parent = runner.dequeue();
      const firstChild = runner.dequeue(parent.issueId);
      const secondChild = runner.dequeue(parent.issueId);

      expect(parent.issueId).toBe('SOT-201');
      expect(firstChild.issueId).toBe('SOT-203');
      expect(secondChild.issueId).toBe('SOT-202');
    });

    it('preserves priority and parent information when lock acquisition failure re-enqueues', async () => {
      const { getQueue } = setupQueueState([
        queueItem('SOT-202', 2, {
          issueIdentifier: 'SOT-202',
          priorityLabel: 'High',
          parentIssueId: 'parent-uuid',
          parentIssueIdentifier: 'SOT-201',
          queueGroup: 'parent-uuid',
          queueGroupOrder: '2026-06-16T00:00:00.000Z'
        })
      ], { lockHeld: true });

      await runner.drainQueue();

      expect(getQueue()).toEqual([
        expect.objectContaining({
          issueId: 'SOT-202',
          priority: 2,
          priorityLabel: 'High',
          priorityRank: 2,
          parentIssueId: 'parent-uuid',
          parentIssueIdentifier: 'SOT-201',
          queueGroup: 'parent-uuid',
          queueGroupOrder: '2026-06-16T00:00:00.000Z',
          reason: 'lock_conflict'
        })
      ]);
    });

    it('preserves priority and parent information when usage-limit retry re-enqueues', async () => {
      const { getQueue } = setupQueueState([]);
      const item = queueItem('SOT-202', 2, {
        issueIdentifier: 'SOT-202',
        priorityLabel: 'High',
        parentIssueId: 'parent-uuid',
        parentIssueIdentifier: 'SOT-201',
        queueGroup: 'parent-uuid',
        queueGroupOrder: '2026-06-16T00:00:00.000Z'
      });
      mockRunAutoExit(1, 'Your limit will reset at 11:59pm (UTC)');

      await runner.runItem(item);

      expect(getQueue()).toEqual([
        expect.objectContaining({
          issueId: 'SOT-202',
          priority: 2,
          priorityLabel: 'High',
          priorityRank: 2,
          parentIssueId: 'parent-uuid',
          parentIssueIdentifier: 'SOT-201',
          queueGroup: 'parent-uuid',
          queueGroupOrder: '2026-06-16T00:00:00.000Z',
          reason: 'usage_limit'
        })
      ]);
      expect(getQueue()[0].retryAt).toEqual(expect.any(String));
    });

    it('dequeue() skips items with future retryAt, returns null when no ready items', () => {
      const future = new Date(Date.now() + 3600000).toISOString();
      const queue = [
        { issueId: 'SOT-1', trigger: 'webhook', retryAt: future }
      ];
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(queue));
      
      const item = runner.dequeue();
      expect(item).toBe(null);
    });

    it('removeFromQueue() removes specific issueId', () => {
      const queue = [
        { issueId: 'SOT-1', trigger: 'webhook' },
        { issueId: 'SOT-2', trigger: 'webhook' }
      ];
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(queue));
      
      runner.removeFromQueue('SOT-1');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.queue.json.tmp'),
        expect.stringContaining('"issueId": "SOT-2"')
      );
    });
  });

  describe('buildUsageLimitCommentBody', () => {
    it('formats epoch seconds as YYYY-MM-DD HH:mm JST', () => {
      // 2026-06-16 02:30 JST = epoch 1781544600
      const result = runner.buildUsageLimitCommentBody(1781544600);
      expect(result).toBe('usage-limit: Next auto run: 2026-06-16 02:30 JST');
    });

    it('produces identical body for same epoch (idempotent)', () => {
      const epoch = 1750009800;
      expect(runner.buildUsageLimitCommentBody(epoch)).toBe(runner.buildUsageLimitCommentBody(epoch));
    });
  });

  describe('postUsageLimitComment', () => {
    let writeSpy: jest.Mock;

    beforeEach(() => {
      jest.clearAllMocks();
      process.env.LINEAR_API_KEY = 'test-key';
      writeSpy = jest.fn();
    });

    function setupLinearMocks(responses: any[]) {
      let index = 0;
      (https.request as jest.Mock).mockImplementation((options: any, callback: any) => {
        const responseData = JSON.stringify({ data: responses[index++] });
        const res: any = {
          on: jest.fn((event: any, cb: any) => {
            if (event === 'data') cb(responseData);
            if (event === 'end') cb();
          })
        };
        callback(res);
        return {
          on: jest.fn(),
          write: writeSpy,
          end: jest.fn(),
          destroy: jest.fn()
        };
      });
    }

    it('skips posting when identical comment already exists', async () => {
      const epoch = 1750009800; // 2026-06-16 02:30 JST
      const body = runner.buildUsageLimitCommentBody(epoch);

      setupLinearMocks([
        { issue: { id: 'uuid-123' } },
        { issue: { comments: { nodes: [{ body }] } } }
      ]);

      await runner.postUsageLimitComment('SOT-602', epoch);

      // Should call 2 times (issue lookup + comments fetch)
      expect(https.request).toHaveBeenCalledTimes(2);
      
      // Verify no commentCreate mutation was sent in any of the write calls
      const writtenBodies = writeSpy.mock.calls.map((c: any) => c[0]);
      expect(writtenBodies.some((b: any) => b.includes('commentCreate'))).toBe(false);
    });

    it('posts comment when no existing comment matches', async () => {
      const epoch = 1750009800;

      setupLinearMocks([
        { issue: { id: 'uuid-123' } },
        { issue: { comments: { nodes: [] } } },
        { commentCreate: { success: true } }
      ]);

      await runner.postUsageLimitComment('SOT-602', epoch);

      expect(https.request).toHaveBeenCalledTimes(3);
      const writtenBodies = writeSpy.mock.calls.map((c: any) => c[0]);
      expect(writtenBodies.some((b: any) => b.includes('commentCreate'))).toBe(true);
    });

    it('posts comment when existing comment has different body', async () => {
      const epoch = 1750009800;
      const differentBody = 'usage-limit: Next auto run: 2026-06-16 04:10 JST';

      setupLinearMocks([
        { issue: { id: 'uuid-123' } },
        { issue: { comments: { nodes: [{ body: differentBody }] } } },
        { commentCreate: { success: true } }
      ]);

      await runner.postUsageLimitComment('SOT-602', epoch);

      expect(https.request).toHaveBeenCalledTimes(3);
      const writtenBodies = writeSpy.mock.calls.map((c: any) => c[0]);
      expect(writtenBodies.some((b: any) => b.includes('commentCreate'))).toBe(true);
    });
  });

  describe('finalizeParentIfChildrenComplete', () => {
    let writeSpy: jest.Mock;

    beforeEach(() => {
      jest.clearAllMocks();
      process.env.LINEAR_API_KEY = 'test-key';
      writeSpy = jest.fn();
    });

    function setupLinearMocks(responses: any[]) {
      let index = 0;
      (https.request as jest.Mock).mockImplementation((options: any, callback: any) => {
        const responseData = JSON.stringify({ data: responses[index++] });
        const res: any = {
          on: jest.fn((event: any, cb: any) => {
            if (event === 'data') cb(responseData);
            if (event === 'end') cb();
          })
        };
        callback(res);
        return {
          on: jest.fn(),
          write: writeSpy,
          end: jest.fn(),
          destroy: jest.fn()
        };
      });
    }

    const startedState = { name: 'In Progress', type: 'started' };
    const doneState = { name: 'Done', type: 'completed' };
    const reviewState = { name: 'In Review', type: 'started' };
    const holdState = { name: 'On Hold', type: 'completed' };

    it('returns false immediately when parentId is null (no Linear calls)', async () => {
      const result = await runner.finalizeParentIfChildrenComplete('SOT-831', null);
      expect(result).toBe(false);
      expect(https.request).not.toHaveBeenCalled();
    });

    it('moves parent to In Review and comments when all children are terminal', async () => {
      setupLinearMocks([
        { issue: { id: 'parent-uuid', identifier: 'SOT-829', state: startedState, team: { id: 'team-1' },
          children: { nodes: [
            { identifier: 'SOT-831', state: doneState },
            { identifier: 'SOT-832', state: doneState }
          ] } } },
        { issue: { comments: { nodes: [] } } },
        { workflowStates: { nodes: [
          { id: 'state-progress', name: 'In Progress', type: 'started' },
          { id: 'state-review', name: 'In Review', type: 'started' }
        ] } },
        { issueUpdate: { success: true } },
        { commentCreate: { success: true } }
      ]);

      const result = await runner.finalizeParentIfChildrenComplete('SOT-832', 'SOT-829');

      expect(result).toBe(true);
      expect(https.request).toHaveBeenCalledTimes(5);
      const written = writeSpy.mock.calls.map((c: any) => c[0]);
      expect(written.some((b: any) => b.includes('issueUpdate') && b.includes('state-review'))).toBe(true);
      expect(written.some((b: any) => b.includes('commentCreate') && b.includes('auto-parent-finalized'))).toBe(true);
    });

    it('moves parent to In Review when all children are In Review (hold, not terminal) (SOT-1551)', async () => {
      setupLinearMocks([
        { issue: { id: 'parent-uuid', identifier: 'SOT-829', state: startedState, team: { id: 'team-1' },
          children: { nodes: [
            { identifier: 'SOT-831', state: reviewState },
            { identifier: 'SOT-832', state: reviewState }
          ] } } },
        { issue: { comments: { nodes: [] } } },
        { workflowStates: { nodes: [
          { id: 'state-progress', name: 'In Progress', type: 'started' },
          { id: 'state-review', name: 'In Review', type: 'started' }
        ] } },
        { issueUpdate: { success: true } },
        { commentCreate: { success: true } }
      ]);

      const result = await runner.finalizeParentIfChildrenComplete('SOT-832', 'SOT-829');

      expect(result).toBe(true);
      expect(https.request).toHaveBeenCalledTimes(5);
      const written = writeSpy.mock.calls.map((c: any) => c[0]);
      expect(written.some((b: any) => b.includes('issueUpdate') && b.includes('state-review'))).toBe(true);
      expect(written.some((b: any) => b.includes('commentCreate') && b.includes('auto-parent-finalized'))).toBe(true);
    });

    it('moves parent to In Review when children are a mix of Done and In Review (SOT-1551)', async () => {
      setupLinearMocks([
        { issue: { id: 'parent-uuid', identifier: 'SOT-829', state: startedState, team: { id: 'team-1' },
          children: { nodes: [
            { identifier: 'SOT-831', state: doneState },
            { identifier: 'SOT-832', state: reviewState }
          ] } } },
        { issue: { comments: { nodes: [] } } },
        { workflowStates: { nodes: [
          { id: 'state-progress', name: 'In Progress', type: 'started' },
          { id: 'state-review', name: 'In Review', type: 'started' }
        ] } },
        { issueUpdate: { success: true } },
        { commentCreate: { success: true } }
      ]);

      const result = await runner.finalizeParentIfChildrenComplete('SOT-832', 'SOT-829');

      expect(result).toBe(true);
    });

    it('resumes a Kaggle improvement parent to Todo after every child completes', async () => {
      setupLinearMocks([
        { issue: {
          id: 'parent-uuid', identifier: 'SOT-2000',
          title: '[demo-gpt] Kaggle順位向上サイクル第2次 — 改善方針の立案と実施',
          description: 'workers: solo=codex\n\n## 入力材料（cronが自動収集・要約なし）',
          state: reviewState, team: { id: 'team-1' },
          children: { nodes: [
            { identifier: 'SOT-2001', state: doneState },
            { identifier: 'SOT-2002', state: reviewState }
          ] }
        } },
        { issue: { comments: { nodes: [] } } },
        { workflowStates: { nodes: [
          { id: 'state-todo', name: 'Todo', type: 'unstarted' },
          { id: 'state-review', name: 'In Review', type: 'started' }
        ] } },
        { issueUpdate: { success: true } },
        { commentCreate: { success: true } }
      ]);

      const result = await runner.finalizeParentIfChildrenComplete('SOT-2002', 'SOT-2000');

      expect(result).toBe(true);
      const written = writeSpy.mock.calls.map((c: any) => c[0]);
      expect(written.some((b: any) => b.includes('issueUpdate') && b.includes('state-todo'))).toBe(true);
      expect(written.some((b: any) => b.includes('auto-parent-resumed'))).toBe(true);
      expect(written.some((b: any) => b.includes('集約・提出フェーズ'))).toBe(true);
    });

    it('keeps a Kaggle improvement parent in review while any child is active', async () => {
      setupLinearMocks([
        { issue: {
          id: 'parent-uuid', identifier: 'SOT-2000',
          title: '[demo-gpt] Kaggle順位向上サイクル第2次 — 改善方針の立案と実施',
          description: '## 入力材料（cronが自動収集・要約なし）',
          state: reviewState, team: { id: 'team-1' },
          children: { nodes: [
            { identifier: 'SOT-2001', state: reviewState },
            { identifier: 'SOT-2002', state: startedState }
          ] }
        } }
      ]);

      const result = await runner.finalizeParentIfChildrenComplete('SOT-2001', 'SOT-2000');

      expect(result).toBe(false);
      expect(https.request).toHaveBeenCalledTimes(1);
      const written = writeSpy.mock.calls.map((c: any) => c[0]);
      expect(written.some((b: any) => b.includes('issueUpdate'))).toBe(false);
    });

    it('resumes an On Hold parent to Todo when all prerequisite children complete (SOT-1816)', async () => {
      setupLinearMocks([
        { issue: { id: 'parent-uuid', identifier: 'SOT-1813', state: holdState, team: { id: 'team-1' },
          children: { nodes: [{ identifier: 'SOT-1815', state: reviewState }] } } },
        { issue: { comments: { nodes: [] } } },
        { workflowStates: { nodes: [
          { id: 'state-todo', name: 'Todo', type: 'unstarted' },
          { id: 'state-review', name: 'In Review', type: 'started' }
        ] } },
        { issueUpdate: { success: true } },
        { commentCreate: { success: true } }
      ]);

      const result = await runner.finalizeParentIfChildrenComplete('SOT-1815', 'SOT-1813');

      expect(result).toBe(true);
      const written = writeSpy.mock.calls.map((c: any) => c[0]);
      expect(written.some((b: any) => b.includes('issueUpdate') && b.includes('state-todo'))).toBe(true);
      expect(written.some((b: any) => b.includes('commentCreate') && b.includes('auto-parent-resumed'))).toBe(true);
    });

    it('does nothing when a child is still active (Todo/In Progress) even if others are In Review (SOT-1551)', async () => {
      setupLinearMocks([
        { issue: { id: 'parent-uuid', identifier: 'SOT-829', state: startedState, team: { id: 'team-1' },
          children: { nodes: [
            { identifier: 'SOT-831', state: reviewState },
            { identifier: 'SOT-832', state: startedState }
          ] } } }
      ]);

      const result = await runner.finalizeParentIfChildrenComplete('SOT-831', 'SOT-829');

      expect(result).toBe(false);
      expect(https.request).toHaveBeenCalledTimes(1); // only the parent query
      const written = writeSpy.mock.calls.map((c: any) => c[0]);
      expect(written.some((b: any) => b.includes('issueUpdate'))).toBe(false);
    });

    it('does nothing when a child is still non-terminal', async () => {
      setupLinearMocks([
        { issue: { id: 'parent-uuid', identifier: 'SOT-829', state: startedState, team: { id: 'team-1' },
          children: { nodes: [
            { identifier: 'SOT-831', state: doneState },
            { identifier: 'SOT-832', state: startedState }
          ] } } }
      ]);

      const result = await runner.finalizeParentIfChildrenComplete('SOT-831', 'SOT-829');

      expect(result).toBe(false);
      expect(https.request).toHaveBeenCalledTimes(1); // only the parent query
      const written = writeSpy.mock.calls.map((c: any) => c[0]);
      expect(written.some((b: any) => b.includes('issueUpdate'))).toBe(false);
      expect(written.some((b: any) => b.includes('commentCreate'))).toBe(false);
    });

    it('is idempotent: skips when finalization marker already present', async () => {
      setupLinearMocks([
        { issue: { id: 'parent-uuid', identifier: 'SOT-829', state: startedState, team: { id: 'team-1' },
          children: { nodes: [
            { identifier: 'SOT-831', state: doneState },
            { identifier: 'SOT-832', state: doneState }
          ] } } },
        { issue: { comments: { nodes: [{ body: '<!-- auto-parent-finalized -->\nalready done' }] } } }
      ]);

      const result = await runner.finalizeParentIfChildrenComplete('SOT-832', 'SOT-829');

      expect(result).toBe(false);
      expect(https.request).toHaveBeenCalledTimes(2); // parent query + comments query, then stop
      const written = writeSpy.mock.calls.map((c: any) => c[0]);
      expect(written.some((b: any) => b.includes('issueUpdate'))).toBe(false);
      expect(written.some((b: any) => b.includes('commentCreate'))).toBe(false);
    });

    it('skips when parent is already terminal', async () => {
      setupLinearMocks([
        { issue: { id: 'parent-uuid', identifier: 'SOT-829', state: doneState, team: { id: 'team-1' },
          children: { nodes: [{ identifier: 'SOT-831', state: doneState }] } } }
      ]);

      const result = await runner.finalizeParentIfChildrenComplete('SOT-831', 'SOT-829');

      expect(result).toBe(false);
      expect(https.request).toHaveBeenCalledTimes(1);
    });
  });

  describe('normalizeQueue', () => {
    it('deduplicates items with same issueId and merges retryAt', () => {
      const future1 = new Date(Date.now() + 10000).toISOString();
      const future2 = new Date(Date.now() + 20000).toISOString();
      const queue = [
        { issueId: 'SOT-1', retryAt: future2, attemptCount: 1, enqueuedAt: '2026-06-16T00:00:00Z' },
        { issueId: 'SOT-1', retryAt: future1, attemptCount: 1, enqueuedAt: '2026-06-16T00:01:00Z' }
      ];
      const normalized = runner.normalizeQueue(queue);
      expect(normalized.length).toBe(1);
      expect(normalized[0].issueId).toBe('SOT-1');
      expect(normalized[0].retryAt).toBe(future1);
      expect(normalized[0].attemptCount).toBe(2);
      expect(normalized[0].enqueuedAt).toBe('2026-06-16T00:00:00Z');
    });

    it('immediate (null retryAt) beats future time', () => {
      const future = new Date(Date.now() + 10000).toISOString();
      const queue = [
        { issueId: 'SOT-1', retryAt: future },
        { issueId: 'SOT-1', retryAt: null }
      ];
      const normalized = runner.normalizeQueue(queue);
      expect(normalized[0].retryAt).toBe(null);
    });

    it('keeps items with different issueIds unchanged', () => {
      const queue = [
        { issueId: 'SOT-1' },
        { issueId: 'SOT-2' }
      ];
      const normalized = runner.normalizeQueue(queue);
      expect(normalized.length).toBe(2);
    });
  });

  describe('syncQueueWithLinear', () => {
    let writeSpy: jest.Mock;
    beforeEach(() => {
      writeSpy = jest.fn();
    });

    function setupLinearMocks(responses: any[]) {
      let index = 0;
      (https.request as jest.Mock).mockImplementation((options: any, callback: any) => {
        const responseData = JSON.stringify({ data: responses[index++] });
        const res: any = {
          on: jest.fn((event: any, cb: any) => {
            if (event === 'data') cb(responseData);
            if (event === 'end') cb();
          })
        };
        callback(res);
        return {
          on: jest.fn(),
          write: writeSpy,
          end: jest.fn(),
          destroy: jest.fn()
        };
      });
    }

    it('removes not-found issue from queue', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-NOTFOUND' }]));
      setupLinearMocks([{ issue: null }]);

      await runner.syncQueueWithLinear();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.queue.json.tmp'),
        expect.stringContaining('[]')
      );
    });

    it('removes archived issue from queue', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-ARCHIVED' }]));
      setupLinearMocks([{ issue: { id: 'SOT-ARCHIVED', archivedAt: '2026-06-01T00:00:00Z' } }]);

      await runner.syncQueueWithLinear();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.queue.json.tmp'),
        expect.stringContaining('[]')
      );
    });

    it('removes terminal issue from queue', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-DONE' }]));
      setupLinearMocks([{ issue: { id: 'SOT-DONE', state: { type: 'completed', name: 'Done' } } }]);

      await runner.syncQueueWithLinear();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.queue.json.tmp'),
        expect.stringContaining('[]')
      );
    });

    it('keeps active issue in queue', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-ACTIVE' }]));
      setupLinearMocks([{ issue: { id: 'SOT-ACTIVE', state: { type: 'started', name: 'In Progress' } } }]);

      await runner.syncQueueWithLinear();

      // No writeFileSync with empty queue should be called if only active items
      const writeCalls = fs.writeFileSync.mock.calls.filter((c: any) => c[0].includes('runner.queue.json.tmp'));
      // If writeFileSync was called, it should still contain SOT-ACTIVE
      if (writeCalls.length > 0) {
        expect(writeCalls[writeCalls.length - 1][1]).toContain('SOT-ACTIVE');
      }
    });

    it('fail-open: keeps item on API error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-ERROR' }]));
      (https.request as jest.Mock).mockImplementation((options: any, callback: any) => {
        const req: any = new EventEmitter();
        req.write = jest.fn();
        req.end = jest.fn();
        process.nextTick(() => req.emit('error', new Error('API down')));
        return req;
      });

      await runner.syncQueueWithLinear();

      const writeCalls = fs.writeFileSync.mock.calls.filter((c: any) => c[0].includes('runner.queue.json.tmp'));
      expect(writeCalls.length).toBe(0); // Should not save cleaned queue
    });
  });

  describe('refreshQueuePriorities', () => {
    let prevApiKey: string | undefined;
    beforeEach(() => {
      prevApiKey = process.env.LINEAR_API_KEY;
      process.env.LINEAR_API_KEY = 'test-key';
    });
    afterEach(() => {
      if (prevApiKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = prevApiKey;
    });

    function setupLinearMocks(responses: any[]) {
      let index = 0;
      (https.request as jest.Mock).mockImplementation((options: any, callback: any) => {
        const responseData = JSON.stringify({ data: responses[index++] });
        const res: any = {
          on: jest.fn((event: any, cb: any) => {
            if (event === 'data') cb(responseData);
            if (event === 'end') cb();
          })
        };
        callback(res);
        return { on: jest.fn(), write: jest.fn(), end: jest.fn(), destroy: jest.fn() };
      });
    }

    function queueWriteCalls() {
      return fs.writeFileSync.mock.calls.filter((c: any) => c[0].includes('runner.queue.json.tmp'));
    }

    it('updates stale priority from Linear (latest wins)', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-1', priority: 3, priorityRank: 3 }]));
      setupLinearMocks([{ issues: { nodes: [
        { id: 'SOT-1', identifier: 'SOT-1', priority: 1, priorityLabel: 'Urgent', state: { type: 'started', name: 'In Progress' } }
      ] } }]);

      await runner.refreshQueuePriorities();

      const writeCalls = queueWriteCalls();
      expect(writeCalls.length).toBeGreaterThan(0);
      const saved = writeCalls[writeCalls.length - 1][1];
      expect(saved).toContain('"priorityRank": 1');
      expect(saved).toContain('"priority": 1');
    });

    it('does not write when priority is unchanged', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-1', priority: 2, priorityRank: 2 }]));
      setupLinearMocks([{ issues: { nodes: [
        { id: 'SOT-1', identifier: 'SOT-1', priority: 2, priorityLabel: 'High', state: { type: 'started', name: 'In Progress' } }
      ] } }]);

      await runner.refreshQueuePriorities();

      expect(queueWriteCalls().length).toBe(0);
    });

    it('refreshes Linear updatedAt used to order equal-priority issues', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { issueId: 'SOT-1', priority: 2, priorityRank: 2, issueUpdatedAt: '2026-07-18T10:00:00Z' },
        { issueId: 'SOT-2', priority: 2, priorityRank: 2, issueUpdatedAt: '2026-07-18T11:00:00Z' }
      ]));
      setupLinearMocks([{ issues: { nodes: [
        { id: 'SOT-1', identifier: 'SOT-1', priority: 2, priorityLabel: 'High', updatedAt: '2026-07-19T12:00:00Z', state: { type: 'started', name: 'In Progress' } },
        { id: 'SOT-2', identifier: 'SOT-2', priority: 2, priorityLabel: 'High', updatedAt: '2026-07-18T11:00:00Z', state: { type: 'started', name: 'In Progress' } }
      ] } }]);

      await runner.refreshQueuePriorities();

      const saved = queueWriteCalls().at(-1)?.[1];
      expect(saved).toBeDefined();
      expect(JSON.parse(saved).map((item: any) => item.issueId)).toEqual(['SOT-1', 'SOT-2']);
    });

    it('refreshes blocking relations and persists dependency order', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([
        { issueId: 'SOT-2', issueIdentifier: 'SOT-2', priority: 1, priorityRank: 1 },
        { issueId: 'SOT-1', issueIdentifier: 'SOT-1', priority: 4, priorityRank: 4 }
      ]));
      setupLinearMocks([{ issues: { nodes: [
        { id: 'uuid-2', identifier: 'SOT-2', priority: 1, state: { type: 'unstarted', name: 'Todo' },
          inverseRelations: { nodes: [{ type: 'blocks', issue: { id: 'uuid-1', identifier: 'SOT-1' }, relatedIssue: { id: 'uuid-2', identifier: 'SOT-2' } }] } },
        { id: 'uuid-1', identifier: 'SOT-1', priority: 4, state: { type: 'unstarted', name: 'Todo' },
          inverseRelations: { nodes: [] } }
      ] } }]);
      await runner.refreshQueuePriorities();
      const saved = JSON.parse(queueWriteCalls().at(-1)?.[1]);
      expect(saved.map((item: any) => item.issueId)).toEqual(['SOT-1', 'SOT-2']);
    });

    it('fail-open: does not write or throw on API error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-1', priority: 3, priorityRank: 3 }]));
      (https.request as jest.Mock).mockImplementation(() => {
        const req: any = new EventEmitter();
        req.write = jest.fn();
        req.end = jest.fn();
        process.nextTick(() => req.emit('error', new Error('API down')));
        return req;
      });

      await expect(runner.refreshQueuePriorities()).resolves.toBeUndefined();
      expect(queueWriteCalls().length).toBe(0);
    });

    it('empty queue is a no-op (no fetch, no write)', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([]));

      await runner.refreshQueuePriorities();

      expect(https.request).not.toHaveBeenCalled();
      expect(queueWriteCalls().length).toBe(0);
    });
  });

  describe('in-flight tracking', () => {
    it('addInflight and isInflight work', () => {
      fs.existsSync.mockReturnValue(false);
      runner.addInflight('SOT-1');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.inflight.json.tmp'),
        expect.stringContaining('SOT-1')
      );
      
      fs.existsSync.mockImplementation((path: string) => path === runner.INFLIGHT_FILE);
      fs.readFileSync.mockReturnValue(JSON.stringify(['SOT-1']));
      expect(runner.isInflight('SOT-1')).toBe(true);
    });

    it('removeInflight works', () => {
      fs.existsSync.mockImplementation((path: string) => path === runner.INFLIGHT_FILE);
      fs.readFileSync.mockReturnValue(JSON.stringify(['SOT-1', 'SOT-2']));
      
      runner.removeInflight('SOT-1');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.inflight.json.tmp'),
        expect.stringContaining('SOT-2')
      );
    });

    it('isQueuedOrRunning returns true if queued', () => {
      fs.existsSync.mockImplementation((path: string) => path === runner.QUEUE_FILE);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-1' }]));
      expect(runner.isQueuedOrRunning('SOT-1')).toBe(true);
    });

    it('isQueuedOrRunning returns true if inflight', () => {
      fs.existsSync.mockImplementation((path: string) => path === runner.INFLIGHT_FILE);
      fs.readFileSync.mockReturnValue(JSON.stringify(['SOT-1']));
      expect(runner.isQueuedOrRunning('SOT-1')).toBe(true);
    });

    it('reapStaleInflight reaps entries older than TTL when unlocked', () => {
      const old = new Date(Date.now() - (runner.INFLIGHT_TTL_MS + 60000)).toISOString();
      fs.existsSync.mockImplementation((path: string) => path === runner.INFLIGHT_FILE);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-1', startedAt: old }]));

      const n = runner.reapStaleInflight();

      expect(n).toEqual(['SOT-1']);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.inflight.json.tmp'),
        expect.not.stringContaining('SOT-1')
      );
    });

    it('reapStaleInflight keeps fresh entries', () => {
      const fresh = new Date().toISOString();
      fs.existsSync.mockImplementation((path: string) => path === runner.INFLIGHT_FILE);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-1', startedAt: fresh }]));

      expect(runner.reapStaleInflight()).toEqual([]);
    });

    it('reapStaleInflight treats legacy string[] entries as stale', () => {
      fs.existsSync.mockImplementation((path: string) => path === runner.INFLIGHT_FILE);
      fs.readFileSync.mockReturnValue(JSON.stringify(['SOT-1']));

      expect(runner.reapStaleInflight()).toEqual(['SOT-1']);
    });

    it('reapStaleInflight is a no-op while a run holds the lock', () => {
      fs.existsSync.mockImplementation((path: string) => path === runner.LOCK_FILE || path === runner.INFLIGHT_FILE);
      fs.readFileSync.mockImplementation((path: string) =>
        path === runner.LOCK_FILE
          ? `${process.pid}:${new Date().toISOString()}`
          : JSON.stringify(['SOT-1'])
      );

      expect(runner.reapStaleInflight()).toEqual([]);
    });

    it('reapLeakedInflightAtStartup reaps inflight NOT backed by a live sentinel (foreground leak)', () => {
      const sentPath = runner.detachedSentinelFile('SOT-live');
      fs.existsSync.mockImplementation((p: string) => p === runner.INFLIGHT_FILE || p === sentPath);
      fs.readFileSync.mockImplementation((p: string) => {
        if (p === runner.INFLIGHT_FILE) return JSON.stringify([
          { issueId: 'SOT-leak', startedAt: new Date().toISOString() }, // no sentinel → leaked
          { issueId: 'SOT-live', startedAt: new Date().toISOString() },  // live detached sentinel
        ]);
        if (p === sentPath) return JSON.stringify({ issueId: 'SOT-live', pid: 4242 });
        return '';
      });
      jest.spyOn(process, 'kill').mockImplementation((pid: number) => {
        if (pid === 4242) return true; // live
        const e: any = new Error('no such process'); e.code = 'ESRCH'; throw e;
      });

      const reaped = runner.reapLeakedInflightAtStartup();
      expect(reaped).toEqual(['SOT-leak']);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.inflight.json.tmp'),
        expect.stringContaining('SOT-live')
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.inflight.json.tmp'),
        expect.not.stringContaining('SOT-leak')
      );
    });

    it('reapLeakedInflightAtStartup keeps inflight whose detached run is still alive', () => {
      const sentPath = runner.detachedSentinelFile('SOT-live');
      fs.existsSync.mockImplementation((p: string) => p === runner.INFLIGHT_FILE || p === sentPath);
      fs.readFileSync.mockImplementation((p: string) => {
        if (p === runner.INFLIGHT_FILE) return JSON.stringify([{ issueId: 'SOT-live', startedAt: new Date().toISOString() }]);
        if (p === sentPath) return JSON.stringify({ issueId: 'SOT-live', pid: 4242 });
        return '';
      });
      jest.spyOn(process, 'kill').mockImplementation(() => true); // all alive

      expect(runner.reapLeakedInflightAtStartup()).toEqual([]);
    });
  });

  describe('pruneExpiredQueueItems', () => {
    let writeSpy: jest.Mock;
    beforeEach(() => {
      writeSpy = jest.fn();
    });

    function setupLinearMocks(responses: any[]) {
      let index = 0;
      (https.request as jest.Mock).mockImplementation((options: any, callback: any) => {
        const responseData = JSON.stringify({ data: responses[index++] });
        const res: any = {
          on: jest.fn((event: any, cb: any) => {
            if (event === 'data') cb(responseData);
            if (event === 'end') cb();
          })
        };
        callback(res);
        return {
          on: jest.fn(),
          write: writeSpy,
          end: jest.fn(),
          destroy: jest.fn()
        };
      });
    }

    it('removes expired terminal issue', async () => {
      const oldDate = new Date(Date.now() - (runner.QUEUE_ITEM_TTL_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-OLD', enqueuedAt: oldDate }]));
      setupLinearMocks([{ issue: { id: 'SOT-OLD', state: { type: 'completed' } } }]);

      await runner.pruneExpiredQueueItems();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.queue.json.tmp'),
        expect.stringContaining('[]')
      );
    });

    it('keeps expired active issue', async () => {
      const oldDate = new Date(Date.now() - (runner.QUEUE_ITEM_TTL_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-OLD-ACTIVE', enqueuedAt: oldDate }]));
      setupLinearMocks([{ issue: { id: 'SOT-OLD-ACTIVE', state: { type: 'started' } } }]);

      await runner.pruneExpiredQueueItems();

      const writeCalls = fs.writeFileSync.mock.calls.filter((c: any) => c[0].includes('runner.queue.json.tmp'));
      expect(writeCalls.length).toBe(0);
    });

    it('does not check recent issues', async () => {
      const recentDate = new Date().toISOString();
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-RECENT', enqueuedAt: recentDate }]));

      await runner.pruneExpiredQueueItems();

      expect(https.request).not.toHaveBeenCalled();
    });

    it('cleanup failure does not drop queue', async () => {
      const oldDate = new Date(Date.now() - (runner.QUEUE_ITEM_TTL_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-KEEP', enqueuedAt: oldDate }]));
      (https.request as jest.Mock).mockImplementation(() => {
        const req: any = new EventEmitter();
        req.write = jest.fn();
        req.end = jest.fn();
        process.nextTick(() => req.emit('error', new Error('Linear unavailable')));
        return req;
      });

      await runner.pruneExpiredQueueItems();

      const writeCalls = fs.writeFileSync.mock.calls.filter((c: any) => c[0].includes('runner.queue.json.tmp'));
      expect(writeCalls.length).toBe(0);
    });
  });

  describe('runItem completion verification', () => {
    let writeSpy: jest.Mock;
    beforeEach(() => {
      writeSpy = jest.fn();
      process.env.LINEAR_API_KEY = 'test-key';
      fs.existsSync.mockReturnValue(true);
    });

    function setupLinearMocks(responses: any[]) {
      let index = 0;
      (https.request as jest.Mock).mockImplementation((options: any, callback: any) => {
        const responseData = JSON.stringify({ data: responses[index++] });
        const res: any = {
          on: jest.fn((event: any, cb: any) => {
            if (event === 'data') cb(responseData);
            if (event === 'end') cb();
          })
        };
        callback(res);
        return {
          on: jest.fn(),
          write: writeSpy,
          end: jest.fn(),
          destroy: jest.fn()
        };
      });
    }

    function queueItem(issueId: string, priority: number | null) {
      return {
        issueId,
        trigger: 'webhook',
        retryAt: null,
        enqueuedAt: new Date().toISOString(),
        priority,
        priorityRank: runner.getPriorityRank(priority)
      };
    }

    function mockRunAutoExit(code: number, output = '') {
      (spawn as jest.Mock).mockImplementation(() => {
        const child: any = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 12345;
        process.nextTick(() => {
          if (output) child.stdout.emit('data', Buffer.from(output));
          child.emit('close', code, null);
        });
        return child;
      });
    }

    it('exits 0 but Linear state is In Progress: skips success cleanup', async () => {
      const item: any = queueItem('SOT-101', 1);
      mockRunAutoExit(0, 'some output');
      setupLinearMocks([
        { issue: { id: 'SOT-101', state: { type: 'started', name: 'In Progress' } } }, // eligibility
        { issue: { project: { name: 'ai-dev-control-plane' } } },                       // triggerRun project->repo fetch
        { issue: { id: 'SOT-101', state: { type: 'started', name: 'In Progress' } } }  // verification
      ]);

      const logSpy = jest.spyOn(fs, 'appendFileSync');

      await runner.runItem(item);

      const logs = logSpy.mock.calls.map(c => c[1] as string);
      expect(logs.some(l => l.includes('completed successfully'))).toBe(false);
      expect(logs.some(l => l.includes('task completion not verified: state is "In Progress"'))).toBe(true);
    });

    it('keeps a dependency-blocked Blocked issue queued for a later round without starting a worker', async () => {
      const item: any = queueItem('SOT-2020-B', 1);
      item.issueIdentifier = 'SOT-2020-B';
      fs.readFileSync.mockReturnValue('[]');
      setupLinearMocks([
        { issue: {
          id: 'dependent',
          identifier: 'SOT-2020-B',
          archivedAt: null,
          state: { type: 'unstarted', name: 'Blocked' },
          team: { id: 'team-1' },
          labels: { nodes: [] },
          inverseRelations: { nodes: [{
            type: 'blocks',
            issue: {
              id: 'blocker',
              identifier: 'SOT-2020-A',
              archivedAt: null,
              state: { type: 'started', name: 'In Progress' },
            },
          }] },
        } },
      ]);

      const outcome = await runner.runItem(item);
      const queueWrite = [...fs.writeFileSync.mock.calls]
        .reverse()
        .find((call: any[]) => String(call[0]).includes('runner.queue.json.tmp'));
      const queued = JSON.parse(queueWrite?.[1] as string);

      expect(outcome.dependencyBlocked).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toEqual(expect.objectContaining({
        issueId: 'SOT-2020-B',
        reason: 'dependency_blocked',
      }));
      expect(new Date(queued[0].retryAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('exits 0 and output contains COMPLETION_CONTRACT: INCOMPLETE: skips success cleanup', async () => {
      const item: any = queueItem('SOT-101', 1);
      mockRunAutoExit(0, '... COMPLETION_CONTRACT: INCOMPLETE reason=test-reason ...');
      setupLinearMocks([
        { issue: { id: 'SOT-101', state: { type: 'started', name: 'In Progress' } } } // eligibility
      ]);

      const logSpy = jest.spyOn(fs, 'appendFileSync');

      await runner.runItem(item);

      const logs = logSpy.mock.calls.map(c => c[1] as string);
      expect(logs.some(l => l.includes('completed successfully'))).toBe(false);
      expect(logs.some(l => l.includes('task completion not verified: test-reason'))).toBe(true);
    });

    it('exits 0 and Linear state is Done: performs success cleanup', async () => {
      const item: any = queueItem('SOT-101', 1);
      mockRunAutoExit(0, 'COMPLETION_CONTRACT: COMPLETED');
      setupLinearMocks([
        { issue: { id: 'SOT-101', state: { type: 'started', name: 'In Progress' } } }, // eligibility
        { issue: { project: { name: 'ai-dev-control-plane' } } },                       // triggerRun project->repo fetch
        { issue: { id: 'SOT-101', state: { type: 'completed', name: 'Done' } } }       // verification
      ]);

      const logSpy = jest.spyOn(fs, 'appendFileSync');

      await runner.runItem(item);

      const logsFlat = logSpy.mock.calls.map(c => c[1] as string);
      expect(logsFlat.some(l => l.includes('completed successfully'))).toBe(true);
    });

    it('treats an explicit completed contract plus Linear In Review as verified success', async () => {
      const item: any = queueItem('SOT-REVIEWED', 1);
      mockRunAutoExit(0, 'COMPLETION_CONTRACT: COMPLETED');
      setupLinearMocks([
        { issue: { id: 'SOT-REVIEWED', state: { type: 'started', name: 'In Progress' } } },
        { issue: { project: { name: 'ai-dev-control-plane' } } },
        { issue: { id: 'SOT-REVIEWED', state: { type: 'started', name: 'In Review' } } }
      ]);

      const logSpy = jest.spyOn(fs, 'appendFileSync');
      await runner.runItem(item);

      const logs = logSpy.mock.calls.map(c => c[1] as string);
      expect(logs.some(l => l.includes('outcome=TASK_COMPLETED'))).toBe(true);
      expect(logs.some(l => l.includes('task completion not verified'))).toBe(false);
    });

    it('does not trust Linear In Review without an explicit completed contract', async () => {
      const item: any = queueItem('SOT-UNVERIFIED-REVIEW', 1);
      mockRunAutoExit(0, 'worker exited without a completion contract');
      setupLinearMocks([
        { issue: { id: 'SOT-UNVERIFIED-REVIEW', state: { type: 'started', name: 'In Progress' } } },
        { issue: { project: { name: 'ai-dev-control-plane' } } },
        { issue: { id: 'SOT-UNVERIFIED-REVIEW', state: { type: 'started', name: 'In Review' } } }
      ]);

      const logSpy = jest.spyOn(fs, 'appendFileSync');
      await runner.runItem(item);

      const logs = logSpy.mock.calls.map(c => c[1] as string);
      expect(logs.some(l => l.includes('outcome=COMPLETION_UNVERIFIED'))).toBe(true);
    });

    it('exits 70 (COMPLETION_UNVERIFIED): skips success cleanup', async () => {
      const item: any = queueItem('SOT-101', 1);
      mockRunAutoExit(70, 'COMPLETION_CONTRACT: INCOMPLETE');
      setupLinearMocks([
        { issue: { id: 'SOT-101', state: { type: 'started', name: 'In Progress' } } } // eligibility
      ]);

      const logSpy = jest.spyOn(fs, 'appendFileSync');

      await runner.runItem(item);

      const logs = logSpy.mock.calls.map(c => c[1] as string);
      expect(logs.some(l => l.includes('completed successfully'))).toBe(false);
      expect(logs.some(l => l.includes('process exited 70 (COMPLETION_UNVERIFIED)'))).toBe(true);
    });

    it('exits 0 with COMPLETION_CONTRACT: COMPLETED_NO_PR: terminal success, not re-injected (SOT-1550)', async () => {
      const item: any = queueItem('SOT-101', 1);
      // No-PR PLAN/REVIEW terminal: run_auto.sh emits the marker; verifyTaskCompletion short-circuits
      // on it (no Linear state query), so only eligibility + triggerRun project fetch hit Linear.
      mockRunAutoExit(0, '... COMPLETION_CONTRACT: COMPLETED_NO_PR ...');
      setupLinearMocks([
        { issue: { id: 'SOT-101', state: { type: 'started', name: 'In Progress' } } }, // eligibility
        { issue: { project: { name: 'ai-dev-control-plane' } } }                        // triggerRun project->repo fetch
      ]);

      const logSpy = jest.spyOn(fs, 'appendFileSync');

      await runner.runItem(item);

      const logs = logSpy.mock.calls.map(c => c[1] as string);
      // Classified as a terminal success (COMPLETED_NO_PR), NOT COMPLETION_UNVERIFIED.
      expect(logs.some(l => l.includes('completed successfully (no PR'))).toBe(true);
      expect(logs.some(l => l.includes('outcome=COMPLETED_NO_PR'))).toBe(true);
      expect(logs.some(l => l.includes('task completion not verified'))).toBe(false);
      // Being a success, it never records a code=70 human-wait termination → reaper won't re-enqueue it.
      expect(logs.some(l => l.includes('human-wait recorded'))).toBe(false);
    });

    it('Linear query fails during verification: fail-closed, skips success cleanup', async () => {
      const item: any = queueItem('SOT-101', 1);
      mockRunAutoExit(0, 'some output');
      
      let callCount = 0;
      (https.request as jest.Mock).mockImplementation((options: any, callback: any) => {
        callCount++;
        if (callCount === 1) {
          const responseData = JSON.stringify({ data: { issue: { id: 'SOT-101', state: { type: 'started', name: 'In Progress' } } } });
          const res: any = { on: jest.fn((event: any, cb: any) => {
            if (event === 'data') cb(responseData);
            if (event === 'end') cb();
          })};
          callback(res);
          return { on: jest.fn(), write: jest.fn(), end: jest.fn() };
        } else {
          const req: any = new EventEmitter();
          req.write = jest.fn();
          req.end = jest.fn();
          process.nextTick(() => req.emit('error', new Error('Linear API Timeout')));
          return req;
        }
      });

      const logSpy = jest.spyOn(fs, 'appendFileSync');

      await runner.runItem(item);

      const logs = logSpy.mock.calls.map(c => c[1] as string);
      expect(logs.some(l => l.includes('completed successfully'))).toBe(false);
      expect(logs.some(l => l.includes('task completion not verified: verification unavailable: Linear API Timeout'))).toBe(true);
    });

    it('exits 75 (run_auto.sh flock held): re-enqueues with backoff retryAt and signals lock conflict', async () => {
      const item: any = queueItem('SOT-101', 1);
      mockRunAutoExit(75, 'run_auto.sh is already running (script-launched). Skipping.');
      setupLinearMocks([
        { issue: { id: 'SOT-101', state: { type: 'started', name: 'In Progress' } } }, // eligibility
        { issue: { project: { name: 'ai-dev-control-plane' } } }                        // triggerRun project->repo fetch
      ]);

      const before = Date.now();
      const result = await runner.runItem(item);

      // runItem signals drainQueue to stop this pass instead of hammering the held lock
      expect(result.lockConflict).toBe(true);
      expect(result.detached).toBe(false);

      const queueWrites = (fs.writeFileSync as jest.Mock).mock.calls
        .filter(c => typeof c[0] === 'string' && (c[0] as string).includes('runner.queue.json'))
        .map(c => { try { return JSON.parse(c[1] as string); } catch { return null; } })
        .filter(Boolean);
      const lastQueue = queueWrites[queueWrites.length - 1];
      const requeued = lastQueue.find((q: any) => q.issueId === 'SOT-101');
      expect(requeued).toBeDefined();
      expect(requeued.reason).toBe('lock_conflict');
      // backed off into the future (not null) so the drain stops rather than tight-looping
      expect(requeued.retryAt).toEqual(expect.any(String));
      expect(new Date(requeued.retryAt).getTime()).toBeGreaterThan(before);
    });
  });

  describe('long-run detached mode (SOT-914)', () => {
    let writeSpy: jest.Mock;
    beforeEach(() => {
      writeSpy = jest.fn();
      process.env.LINEAR_API_KEY = 'test-key';
    });

    function setupLinearMocks(responses: any[]) {
      let index = 0;
      (https.request as jest.Mock).mockImplementation((options: any, callback: any) => {
        const responseData = JSON.stringify({ data: responses[index++] });
        const res: any = {
          on: jest.fn((event: any, cb: any) => {
            if (event === 'data') cb(responseData);
            if (event === 'end') cb();
          })
        };
        callback(res);
        return { on: jest.fn(), write: writeSpy, end: jest.fn(), destroy: jest.fn() };
      });
    }

    function queueItem(issueId: string) {
      return {
        issueId,
        trigger: 'webhook',
        retryAt: null,
        enqueuedAt: new Date().toISOString(),
        priority: 2,
        priorityRank: runner.getPriorityRank(2)
      };
    }

    // A detached spawn: child with pid + unref, never emits 'close' (we must NOT await it).
    function mockDetachedSpawn(pid = 99999) {
      const child: any = new EventEmitter();
      child.pid = pid;
      child.unref = jest.fn();
      (spawn as jest.Mock).mockReturnValue(child);
      return child;
    }

    it('retains an item and launches no worker while the runner is paused', async () => {
      runner.setRunnerPausedState(true);
      const item: any = queueItem('SOT-PAUSED');

      const outcome = await runner.runItem(item);

      expect(outcome).toEqual({ lockConflict: false, detached: false, paused: true });
      expect(spawn).not.toHaveBeenCalled();
      const queueWrites = (fs.writeFileSync as jest.Mock).mock.calls
        .filter(c => typeof c[0] === 'string' && c[0].includes('runner.queue.json'));
      expect(queueWrites.length).toBeGreaterThan(0);
      expect(queueWrites.at(-1)?.[1]).toContain('SOT-PAUSED');
    });

    it('marks an explicitly unmapped project fail-closed instead of falling back to control-plane', async () => {
      setupLinearMocks([
        { issue: { project: { name: 'future-unconfigured-project' } } }
      ]);

      const env = await runner.buildRunEnv('SOT-UNMAPPED', {
        WEBHOOK_PROJECT_NAME: 'stale-project',
        WEBHOOK_TARGET_REPO: '/tmp/stale-target',
        RUNNER_REPO_RESOLUTION_ERROR: 'stale error'
      });

      expect(env.WEBHOOK_TARGET_REPO).toBeUndefined();
      expect(env.WEBHOOK_PROJECT_NAME).toBeUndefined();
      expect(env.RUNNER_REPO_RESOLUTION_ERROR).toContain('future-unconfigured-project');
    });

    it('long-run label → detached launch, immediate return, inflight + sentinel recorded', async () => {
      fs.existsSync.mockReturnValue(false);
      const item: any = queueItem('SOT-200');
      const child = mockDetachedSpawn(54321);
      setupLinearMocks([
        // eligibility query (carries the long-run label)
        { issue: { id: 'SOT-200', state: { type: 'started', name: 'In Progress' }, labels: { nodes: [{ name: 'long-run' }] } } },
        // buildRunEnv -> getIssueProjectName
        { issue: { project: { name: 'ai-dev-control-plane' } } }
      ]);

      const outcome = await runner.runItem(item);

      expect(outcome).toEqual({ lockConflict: false, detached: true });
      // spawned detached, unref'd, and we never registered a 'close' listener (fire-and-forget)
      expect(spawn).toHaveBeenCalledTimes(1);
      const spawnOpts: any = (spawn as jest.Mock).mock.calls[0][2];
      expect(spawnOpts.detached).toBe(true);
      expect(spawnOpts.stdio).toBe('ignore');
      expect(child.unref).toHaveBeenCalled();
      // inflight entry written
      const inflightWrites = (fs.writeFileSync as jest.Mock).mock.calls
        .filter(c => typeof c[0] === 'string' && (c[0] as string).includes('runner.inflight.json'));
      expect(inflightWrites.length).toBeGreaterThan(0);
      // sentinel written under DETACHED_DIR with pid
      const sentinelWrites = (fs.writeFileSync as jest.Mock).mock.calls
        .filter(c => typeof c[0] === 'string' && (c[0] as string).includes('SOT-200.json'));
      expect(sentinelWrites.length).toBeGreaterThan(0);
      expect(sentinelWrites[0][1]).toContain('54321');
    });

    it('normal issue (no long-run label) stays on the synchronous path', async () => {
      fs.existsSync.mockReturnValue(true);
      const item: any = queueItem('SOT-201');
      // synchronous spawn that emits close(0)
      (spawn as jest.Mock).mockImplementation(() => {
        const child: any = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 12345;
        process.nextTick(() => child.emit('close', 0, null));
        return child;
      });
      setupLinearMocks([
        { issue: { id: 'SOT-201', state: { type: 'started', name: 'In Progress' }, labels: { nodes: [{ name: 'other' }] } } },
        { issue: { project: { name: 'ai-dev-control-plane' } } },
        { issue: { id: 'SOT-201', state: { type: 'completed', name: 'Done' } } }
      ]);

      const outcome = await runner.runItem(item);

      expect(outcome.detached).toBe(false);
      // no sentinel file written for a normal run
      const sentinelWrites = (fs.writeFileSync as jest.Mock).mock.calls
        .filter(c => typeof c[0] === 'string' && (c[0] as string).includes('SOT-201.json'));
      expect(sentinelWrites.length).toBe(0);
    });

    it('writeDetachedSentinel + clearDetachedSentinel manage the per-issue file', () => {
      fs.existsSync.mockReturnValue(true);
      runner.writeDetachedSentinel('SOT-300', 4242);
      const target = runner.detachedSentinelFile('SOT-300');
      expect(target.startsWith(runner.DETACHED_DIR)).toBe(true);
      const written: any = (fs.writeFileSync as jest.Mock).mock.calls
        .find(c => (c[0] as string).includes('SOT-300.json.tmp'));
      expect(written).toBeDefined();
      expect(written[1]).toContain('4242');

      runner.clearDetachedSentinel('SOT-300');
      expect(fs.unlinkSync).toHaveBeenCalledWith(target);
    });

    it('reapDeadDetachedSentinels clears sentinels whose pid is dead and keeps live ones', () => {
      fs.existsSync.mockImplementation((p: string) => p === runner.DETACHED_DIR || p.includes('.json'));
      fs.readdirSync.mockReturnValue(['SOT-400.json', 'SOT-401.json']);
      fs.readFileSync.mockImplementation((p: string) => {
        if (p.includes('SOT-400')) return JSON.stringify({ issueId: 'SOT-400', pid: 111, startedAt: new Date().toISOString() });
        if (p.includes('SOT-401')) return JSON.stringify({ issueId: 'SOT-401', pid: 222, startedAt: new Date().toISOString() });
        return JSON.stringify([]);
      });
      // pid 111 dead (ESRCH), pid 222 alive
      jest.spyOn(process, 'kill').mockImplementation((pid: number) => {
        if (pid === 111) { const e: any = new Error('no such process'); e.code = 'ESRCH'; throw e; }
        return true;
      });

      const cleared = runner.reapDeadDetachedSentinels();

      expect(cleared).toEqual(['SOT-400']);
      expect(fs.unlinkSync).toHaveBeenCalledWith(runner.detachedSentinelFile('SOT-400'));
      expect(fs.unlinkSync).not.toHaveBeenCalledWith(runner.detachedSentinelFile('SOT-401'));
    });
  });

  // SOT-934: default-detach. RUNNER_DEFAULT_DETACH makes a NORMAL run (no long-run label) detach too,
  // so the webhook releases the lock immediately instead of holding it for the whole run. Default off
  // keeps the historical synchronous foreground path (後方互換).
  describe('default-detach (SOT-934)', () => {
    let writeSpy: jest.Mock;
    let prevDefaultDetach: string | undefined;
    beforeEach(() => {
      writeSpy = jest.fn();
      process.env.LINEAR_API_KEY = 'test-key';
      prevDefaultDetach = process.env.RUNNER_DEFAULT_DETACH;
      delete process.env.RUNNER_DEFAULT_DETACH;
    });
    afterEach(() => {
      if (prevDefaultDetach === undefined) delete process.env.RUNNER_DEFAULT_DETACH;
      else process.env.RUNNER_DEFAULT_DETACH = prevDefaultDetach;
    });

    function setupLinearMocks(responses: any[]) {
      let index = 0;
      (https.request as jest.Mock).mockImplementation((options: any, callback: any) => {
        const responseData = JSON.stringify({ data: responses[index++] });
        const res: any = {
          on: jest.fn((event: any, cb: any) => {
            if (event === 'data') cb(responseData);
            if (event === 'end') cb();
          })
        };
        callback(res);
        return { on: jest.fn(), write: writeSpy, end: jest.fn(), destroy: jest.fn() };
      });
    }

    function queueItem(issueId: string) {
      return {
        issueId,
        trigger: 'webhook',
        retryAt: null,
        enqueuedAt: new Date().toISOString(),
        priority: 2,
        priorityRank: runner.getPriorityRank(2)
      };
    }

    it('resolveDefaultDetach reads RUNNER_DEFAULT_DETACH (default off, accepts 1/true case-insensitively)', () => {
      expect(runner.resolveDefaultDetach({})).toBe(false);
      expect(runner.resolveDefaultDetach({ RUNNER_DEFAULT_DETACH: '' })).toBe(false);
      expect(runner.resolveDefaultDetach({ RUNNER_DEFAULT_DETACH: '0' })).toBe(false);
      expect(runner.resolveDefaultDetach({ RUNNER_DEFAULT_DETACH: 'no' })).toBe(false);
      expect(runner.resolveDefaultDetach({ RUNNER_DEFAULT_DETACH: '1' })).toBe(true);
      expect(runner.resolveDefaultDetach({ RUNNER_DEFAULT_DETACH: 'true' })).toBe(true);
      expect(runner.resolveDefaultDetach({ RUNNER_DEFAULT_DETACH: ' TRUE ' })).toBe(true);
    });

    it('RUNNER_DEFAULT_DETACH=1 → a normal run (no long-run label) detaches and returns immediately', async () => {
      process.env.RUNNER_DEFAULT_DETACH = '1';
      fs.existsSync.mockReturnValue(false);
      const item: any = queueItem('SOT-934A');
      const child: any = new EventEmitter();
      child.pid = 77777;
      child.unref = jest.fn();
      (spawn as jest.Mock).mockReturnValue(child);
      setupLinearMocks([
        // eligibility query: normal issue, NO long-run label
        { issue: { id: 'SOT-934A', state: { type: 'started', name: 'In Progress' }, labels: { nodes: [{ name: 'other' }] } } },
        // buildRunEnv -> getIssueProjectName
        { issue: { project: { name: 'ai-dev-control-plane' } } }
      ]);

      const outcome = await runner.runItem(item);

      // detached path taken even without the long-run label
      expect(outcome).toEqual({ lockConflict: false, detached: true });
      expect(spawn).toHaveBeenCalledTimes(1);
      const spawnOpts: any = (spawn as jest.Mock).mock.calls[0][2];
      expect(spawnOpts.detached).toBe(true);
      expect(spawnOpts.stdio).toBe('ignore');
      expect(child.unref).toHaveBeenCalled();
      // inflight + sentinel recorded (reaper owns cleanup, same as long-run)
      const inflightWrites = (fs.writeFileSync as jest.Mock).mock.calls
        .filter(c => typeof c[0] === 'string' && (c[0] as string).includes('runner.inflight.json'));
      expect(inflightWrites.length).toBeGreaterThan(0);
      const sentinelWrites = (fs.writeFileSync as jest.Mock).mock.calls
        .filter(c => typeof c[0] === 'string' && (c[0] as string).includes('SOT-934A.json'));
      expect(sentinelWrites.length).toBeGreaterThan(0);
      expect(sentinelWrites[0][1]).toContain('77777');
    });

    it('flag unset (default) → a normal run stays on the synchronous foreground path', async () => {
      fs.existsSync.mockReturnValue(true);
      const item: any = queueItem('SOT-934B');
      (spawn as jest.Mock).mockImplementation(() => {
        const child: any = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 12345;
        process.nextTick(() => child.emit('close', 0, null));
        return child;
      });
      setupLinearMocks([
        { issue: { id: 'SOT-934B', state: { type: 'started', name: 'In Progress' }, labels: { nodes: [{ name: 'other' }] } } },
        { issue: { project: { name: 'ai-dev-control-plane' } } },
        { issue: { id: 'SOT-934B', state: { type: 'completed', name: 'Done' } } }
      ]);

      const outcome = await runner.runItem(item);

      // foreground synchronous path: not detached, no sentinel written
      expect(outcome.detached).toBe(false);
      const sentinelWrites = (fs.writeFileSync as jest.Mock).mock.calls
        .filter(c => typeof c[0] === 'string' && (c[0] as string).includes('SOT-934B.json'));
      expect(sentinelWrites.length).toBe(0);
    });
  });

  // SOT-947: RUNNER_STABLE_MODE master switch. A single env flag forces fully-serial "stable運用":
  // it overrides every parallel/detach toggle (RUNNER_MAX_PARALLEL → 1, RUNNER_SERIALIZE_SCOPE → repo,
  // RUNNER_DEFAULT_DETACH → false) AND disables the always-on `long-run` label detach so long-run
  // issues run synchronously in the foreground. Default off keeps all toggles behaving as before.
  describe('RUNNER_STABLE_MODE master switch (SOT-947)', () => {
    let writeSpy: jest.Mock;
    let prevStableMode: string | undefined;
    let prevDefaultDetach: string | undefined;
    beforeEach(() => {
      writeSpy = jest.fn();
      process.env.LINEAR_API_KEY = 'test-key';
      prevStableMode = process.env.RUNNER_STABLE_MODE;
      prevDefaultDetach = process.env.RUNNER_DEFAULT_DETACH;
      delete process.env.RUNNER_STABLE_MODE;
      delete process.env.RUNNER_DEFAULT_DETACH;
    });
    afterEach(() => {
      if (prevStableMode === undefined) delete process.env.RUNNER_STABLE_MODE;
      else process.env.RUNNER_STABLE_MODE = prevStableMode;
      if (prevDefaultDetach === undefined) delete process.env.RUNNER_DEFAULT_DETACH;
      else process.env.RUNNER_DEFAULT_DETACH = prevDefaultDetach;
    });

    function setupLinearMocks(responses: any[]) {
      let index = 0;
      (https.request as jest.Mock).mockImplementation((options: any, callback: any) => {
        const responseData = JSON.stringify({ data: responses[index++] });
        const res: any = {
          on: jest.fn((event: any, cb: any) => {
            if (event === 'data') cb(responseData);
            if (event === 'end') cb();
          })
        };
        callback(res);
        return { on: jest.fn(), write: writeSpy, end: jest.fn(), destroy: jest.fn() };
      });
    }

    function queueItem(issueId: string) {
      return {
        issueId,
        trigger: 'webhook',
        retryAt: null,
        enqueuedAt: new Date().toISOString(),
        priority: 2,
        priorityRank: runner.getPriorityRank(2)
      };
    }

    it('resolveStableMode reads RUNNER_STABLE_MODE (default off, accepts 1/true case-insensitively)', () => {
      expect(runner.resolveStableMode({})).toBe(false);
      expect(runner.resolveStableMode({ RUNNER_STABLE_MODE: '' })).toBe(false);
      expect(runner.resolveStableMode({ RUNNER_STABLE_MODE: '0' })).toBe(false);
      expect(runner.resolveStableMode({ RUNNER_STABLE_MODE: 'no' })).toBe(false);
      expect(runner.resolveStableMode({ RUNNER_STABLE_MODE: '1' })).toBe(true);
      expect(runner.resolveStableMode({ RUNNER_STABLE_MODE: 'true' })).toBe(true);
      expect(runner.resolveStableMode({ RUNNER_STABLE_MODE: ' TRUE ' })).toBe(true);
    });

    it('stable mode overrides every parallel/detach toggle to its serial value', () => {
      // With stable mode ON, the other env values are ignored.
      expect(runner.resolveMaxParallel({ RUNNER_STABLE_MODE: '1', RUNNER_MAX_PARALLEL: '5' })).toBe(1);
      expect(runner.resolveSerializeScope({ RUNNER_STABLE_MODE: '1', RUNNER_SERIALIZE_SCOPE: 'branch' }))
        .toBe(runner.SERIALIZE_SCOPE_REPO);
      expect(runner.resolveDefaultDetach({ RUNNER_STABLE_MODE: '1', RUNNER_DEFAULT_DETACH: '1' })).toBe(false);
    });

    it('without stable mode the parallel/detach toggles still take effect (no regression)', () => {
      expect(runner.resolveMaxParallel({ RUNNER_MAX_PARALLEL: '5' })).toBe(5);
      expect(runner.resolveSerializeScope({ RUNNER_SERIALIZE_SCOPE: 'branch' }))
        .toBe(runner.SERIALIZE_SCOPE_BRANCH);
      expect(runner.resolveDefaultDetach({ RUNNER_DEFAULT_DETACH: '1' })).toBe(true);
    });

    it('RUNNER_STABLE_MODE=1 → a long-run-labeled issue runs synchronously (no detach)', async () => {
      process.env.RUNNER_STABLE_MODE = '1';
      fs.existsSync.mockReturnValue(true);
      const item: any = queueItem('SOT-947A');
      (spawn as jest.Mock).mockImplementation(() => {
        const child: any = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 24680;
        process.nextTick(() => child.emit('close', 0, null));
        return child;
      });
      setupLinearMocks([
        // eligibility query: issue HAS the long-run label
        { issue: { id: 'SOT-947A', state: { type: 'started', name: 'In Progress' }, labels: { nodes: [{ name: 'long-run' }] } } },
        // buildRunEnv -> getIssueProjectName
        { issue: { project: { name: 'ai-dev-control-plane' } } },
        // post-run verifyTaskCompletion
        { issue: { id: 'SOT-947A', state: { type: 'completed', name: 'Done' } } }
      ]);

      const outcome = await runner.runItem(item);

      // long-run would normally detach, but stable mode forces the synchronous foreground path
      expect(outcome.detached).toBe(false);
      const spawnOpts: any = (spawn as jest.Mock).mock.calls[0][2];
      expect(spawnOpts.detached).not.toBe(true);
      const sentinelWrites = (fs.writeFileSync as jest.Mock).mock.calls
        .filter(c => typeof c[0] === 'string' && (c[0] as string).includes('SOT-947A.json'));
      expect(sentinelWrites.length).toBe(0);
    });
  });

  describe('detached completion → Resume re-injection (SOT-915)', () => {
    let writeSpy: jest.Mock;
    beforeEach(() => {
      writeSpy = jest.fn();
      process.env.LINEAR_API_KEY = 'test-key';
    });

    // Always respond with a "completed" issue so verifyTaskCompletion / cleanup queries succeed.
    function setupLinearAlwaysCompleted() {
      (https.request as jest.Mock).mockImplementation((options: any, callback: any) => {
        const responseData = JSON.stringify({
          data: { issue: { id: 'x', state: { type: 'completed', name: 'Done' } }, issues: { nodes: [] } }
        });
        const res: any = {
          on: jest.fn((event: any, cb: any) => {
            if (event === 'data') cb(responseData);
            if (event === 'end') cb();
          })
        };
        callback(res);
        return { on: jest.fn(), write: writeSpy, end: jest.fn(), destroy: jest.fn() };
      });
    }

    // existsSync: unlocked, DETACHED_DIR present, and per-issue done/log/sentinel files present.
    function unlockedDetachedFs() {
      fs.existsSync.mockImplementation((p: string) =>
        p === runner.DETACHED_DIR ||
        (typeof p === 'string' && (p.includes('.done.json') || p.endsWith('.log') || p.endsWith('.json')))
      );
    }

    it('is a no-op while a run holds the lock', async () => {
      fs.existsSync.mockImplementation((p: string) => p === runner.LOCK_FILE);
      fs.readFileSync.mockImplementation((p: string) => {
        if (p === runner.LOCK_FILE) return `${process.pid}:${new Date().toISOString()}`;
        return '[]';
      });
      fs.readdirSync.mockReturnValue(['SOT-500.done.json']);

      const processed = await runner.reapCompletedDetachedRuns();

      expect(processed).toEqual([]);
      expect(fs.readdirSync).not.toHaveBeenCalledWith(runner.DETACHED_DIR);
    });

    it('post-processes a successful done-marker and clears done/log/sentinel/inflight', async () => {
      unlockedDetachedFs();
      fs.readdirSync.mockReturnValue(['SOT-500.done.json']);
      fs.readFileSync.mockImplementation((p: string) => {
        if (p.includes('.done.json')) return JSON.stringify({ issueId: 'SOT-500', exitCode: 0, endedAt: new Date().toISOString() });
        if (p.endsWith('.log')) return 'run output: all good';
        return '[]';
      });
      setupLinearAlwaysCompleted();

      const processed = await runner.reapCompletedDetachedRuns();

      expect(processed).toEqual(['SOT-500']);
      expect(fs.unlinkSync).toHaveBeenCalledWith(runner.detachedDoneFile('SOT-500'));
      expect(fs.unlinkSync).toHaveBeenCalledWith(runner.detachedLogFile('SOT-500'));
      expect(fs.unlinkSync).toHaveBeenCalledWith(runner.detachedSentinelFile('SOT-500'));
      // inflight rewritten (entry removed)
      const inflightWrites = (fs.writeFileSync as jest.Mock).mock.calls
        .filter(c => typeof c[0] === 'string' && (c[0] as string).includes('runner.inflight.json'));
      expect(inflightWrites.length).toBeGreaterThan(0);
    });

    it('detects an abnormal (non-zero) exit, records it, and cleans up without re-enqueue', async () => {
      unlockedDetachedFs();
      fs.readdirSync.mockReturnValue(['SOT-501.done.json']);
      fs.readFileSync.mockImplementation((p: string) => {
        if (p.includes('.done.json')) return JSON.stringify({ issueId: 'SOT-501', exitCode: 1, endedAt: new Date().toISOString() });
        if (p.endsWith('.log')) return 'fatal: something broke';
        return '[]';
      });

      const processed = await runner.reapCompletedDetachedRuns();

      expect(processed).toEqual(['SOT-501']);
      expect(fs.unlinkSync).toHaveBeenCalledWith(runner.detachedDoneFile('SOT-501'));
      // FAILED result → no resume re-enqueue (no write to the queue file)
      const queueWrites = (fs.writeFileSync as jest.Mock).mock.calls
        .filter(c => typeof c[0] === 'string' && (c[0] as string).includes('runner.queue.json'));
      expect(queueWrites.length).toBe(0);
    });

    it('re-injects a usage-limited detached run into the Resume path (cooldown + re-enqueue)', async () => {
      unlockedDetachedFs();
      fs.readdirSync.mockReturnValue(['SOT-502.done.json']);
      fs.readFileSync.mockImplementation((p: string) => {
        if (p.includes('.done.json')) return JSON.stringify({ issueId: 'SOT-502', exitCode: 1, endedAt: new Date().toISOString() });
        // model_unavailable is retryable and does NOT trigger the session/api notify path.
        if (p.endsWith('.log')) return 'Error: the model is currently unavailable, please retry';
        return '[]';
      });

      const processed = await runner.reapCompletedDetachedRuns();

      expect(processed).toEqual(['SOT-502']);
      // Resume re-injection: the issue is re-enqueued with a retryAt.
      const queueWrites = (fs.writeFileSync as jest.Mock).mock.calls
        .filter(c => typeof c[0] === 'string' && (c[0] as string).includes('runner.queue.json'));
      expect(queueWrites.length).toBeGreaterThan(0);
      expect(queueWrites.some(c => (c[1] as string).includes('SOT-502'))).toBe(true);
      // cleanup still happened
      expect(fs.unlinkSync).toHaveBeenCalledWith(runner.detachedDoneFile('SOT-502'));
    });

    it('drops an unparseable done-marker without throwing', async () => {
      unlockedDetachedFs();
      fs.readdirSync.mockReturnValue(['garbage.done.json']);
      fs.readFileSync.mockImplementation((p: string) => {
        if (p.includes('.done.json')) return 'not-json{{{';
        return '[]';
      });

      const processed = await runner.reapCompletedDetachedRuns();

      expect(processed).toEqual([]);
      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('garbage.done.json'));
    });
  });

  describe('classifyRunResult', () => {
    const { RUN_RESULT, classifyRunResult } = runner;

    it('returns TASK_COMPLETED when code is 0 and task is completed', () => {
      const result = classifyRunResult({
        code: 0,
        output: 'done',
        completion: { completed: true }
      });
      expect(result).toEqual({
        kind: RUN_RESULT.TASK_COMPLETED,
        code: 0,
        completion: { completed: true }
      });
    });

    it('returns COMPLETED_NO_PR when code is 0 and completion is a no-PR terminal (SOT-1550)', () => {
      const result = classifyRunResult({
        code: 0,
        output: 'COMPLETION_CONTRACT: COMPLETED_NO_PR',
        completion: { completed: true, noPr: true }
      });
      expect(result).toEqual({
        kind: RUN_RESULT.COMPLETED_NO_PR,
        code: 0,
        completion: { completed: true, noPr: true }
      });
      // Explicitly distinct from both TASK_COMPLETED and COMPLETION_UNVERIFIED.
      expect(result.kind).not.toBe(RUN_RESULT.TASK_COMPLETED);
      expect(result.kind).not.toBe(RUN_RESULT.COMPLETION_UNVERIFIED);
    });

    it('returns TASK_COMPLETED (not COMPLETED_NO_PR) when completed without the noPr flag', () => {
      const result = classifyRunResult({
        code: 0,
        output: 'done',
        completion: { completed: true, noPr: false }
      });
      expect(result.kind).toBe(RUN_RESULT.TASK_COMPLETED);
    });

    it('returns COMPLETION_UNVERIFIED when code is 0 but task is NOT completed', () => {
      const result = classifyRunResult({
        code: 0,
        output: 'not quite',
        completion: { completed: false, reason: 'state is "In Progress"' }
      });
      expect(result).toEqual({
        kind: RUN_RESULT.COMPLETION_UNVERIFIED,
        code: 0,
        reason: 'state is "In Progress"'
      });
    });

    it('returns COMPLETION_UNVERIFIED when code is 70', () => {
      const result = classifyRunResult({
        code: 70,
        output: 'some output',
        completion: null
      });
      expect(result).toEqual({
        kind: RUN_RESULT.COMPLETION_UNVERIFIED,
        code: 70
      });
    });

    it('returns LOCK_CONFLICT when code is 75', () => {
      const result = classifyRunResult({
        code: 75,
        output: 'locked',
        completion: null
      });
      expect(result).toEqual({
        kind: RUN_RESULT.LOCK_CONFLICT,
        code: 75
      });
    });

    it('returns WORKER_UNAVAILABLE_RETRY when code is 71 (SOT-1584 transient worker-chain exhaustion)', () => {
      const result = classifyRunResult({
        code: 71,
        output: 'WORKER_DISPATCH_EXHAUSTED role=verification',
        completion: null
      });
      expect(result).toEqual({
        kind: RUN_RESULT.WORKER_UNAVAILABLE_RETRY,
        code: 71
      });
      // Distinct from the genuine needs-human stop so the reaper retries instead of moving to In Review.
      expect(result.kind).not.toBe(RUN_RESULT.COMPLETION_UNVERIFIED);
    });

    it('returns USAGE_LIMIT_RETRY for retryable limit output', () => {
      const output = 'Your limit will reset at 11:59pm (UTC)';
      const result = classifyRunResult({
        code: 1,
        output,
        completion: null
      });
      expect(result.kind).toBe(RUN_RESULT.USAGE_LIMIT_RETRY);
      expect(result.code).toBe(1);
      expect(result.classification.type).toBe('session_limit');
      expect(result.classification.retryable).toBe(true);
      expect(result.classification.retryAt).toBeDefined();
    });

    it('returns WORKER_UNAVAILABLE_RETRY (NOT global cooldown) when ONLY codex hit the usage limit (SOT-1587)', () => {
      // codex hit its usage limit and handed off to Claude. This must NOT set the global (Claude-gating)
      // cooldown — codex has its own per-worker cooldown. Separates codex/claude cooldowns.
      const output = "ERROR: You've hit your usage limit. try again at Jul 8th, 2026 5:42 AM.\n"
        + 'CODEX_USAGE_LIMIT: cooldown set until epoch 1783437029, delegating to Claude';
      const result = classifyRunResult({ code: 1, output, completion: null });
      expect(result.kind).toBe(RUN_RESULT.WORKER_UNAVAILABLE_RETRY);
      expect(result.kind).not.toBe(RUN_RESULT.USAGE_LIMIT_RETRY);
    });

    it('returns USAGE_LIMIT_RETRY (global cooldown) when Claude also hit the usage limit (SOT-1587)', () => {
      const output = "ERROR: You've hit your usage limit. try again at Jul 8th, 2026 5:42 AM.\n"
        + 'CODEX_USAGE_LIMIT: cooldown set until epoch 1783437029, delegating to Claude\n'
        + 'CLAUDE_USAGE_LIMIT: cooldown set until epoch 1783437033, delegating';
      const result = classifyRunResult({ code: 1, output, completion: null });
      expect(result.kind).toBe(RUN_RESULT.USAGE_LIMIT_RETRY);
    });

    it('returns NON_RETRYABLE_LIMIT for non-retryable limit output', () => {
      const output = 'maximum context length reached';
      const result = classifyRunResult({
        code: 1,
        output,
        completion: null
      });
      expect(result).toEqual({
        kind: RUN_RESULT.NON_RETRYABLE_LIMIT,
        code: 1,
        classification: expect.objectContaining({
          type: 'context_limit',
          retryable: false
        })
      });
    });

    it('returns FAILED for unknown error output', () => {
      const result = classifyRunResult({
        code: 1,
        output: 'something went wrong',
        completion: null
      });
      expect(result).toEqual({
        kind: RUN_RESULT.FAILED,
        code: 1,
        classification: expect.objectContaining({
          type: 'unknown',
          retryable: false
        })
      });
    });
  });

  // SOT-918: end-to-end parallel "wait task" (待機タスク) scenario. A wait task is a `long-run`-labeled
  // issue launched DETACHED — its heavy process keeps running in the background (the mock child never
  // emits 'close') so the runner must return immediately without blocking the lane. This exercises the
  // full lane + detached parallelism with SEVERAL such tasks at once (launch → lane independence → reap).
  describe('parallel wait-task scenario (SOT-918)', () => {
    let writeSpy: jest.Mock;
    beforeEach(() => {
      writeSpy = jest.fn();
      process.env.LINEAR_API_KEY = 'test-key';
    });

    function queueItem(issueId: string) {
      return {
        issueId,
        trigger: 'webhook',
        retryAt: null,
        enqueuedAt: new Date().toISOString(),
        priority: 2,
        priorityRank: runner.getPriorityRank(2)
      };
    }

    // A detached wait task: child with pid + unref that NEVER emits 'close' (we must not await it).
    function mockDetachedSpawn(pid: number) {
      const child: any = new EventEmitter();
      child.pid = pid;
      child.unref = jest.fn();
      (spawn as jest.Mock).mockReturnValue(child);
      return child;
    }

    function setupLinearMocks(responses: any[]) {
      let index = 0;
      (https.request as jest.Mock).mockImplementation((options: any, callback: any) => {
        const responseData = JSON.stringify({ data: responses[index++] });
        const res: any = {
          on: jest.fn((event: any, cb: any) => {
            if (event === 'data') cb(responseData);
            if (event === 'end') cb();
          })
        };
        callback(res);
        return { on: jest.fn(), write: writeSpy, end: jest.fn(), destroy: jest.fn() };
      });
    }

    function setupLinearAlwaysCompleted() {
      (https.request as jest.Mock).mockImplementation((options: any, callback: any) => {
        const responseData = JSON.stringify({
          data: { issue: { id: 'x', state: { type: 'completed', name: 'Done' } }, issues: { nodes: [] } }
        });
        const res: any = {
          on: jest.fn((event: any, cb: any) => {
            if (event === 'data') cb(responseData);
            if (event === 'end') cb();
          })
        };
        callback(res);
        return { on: jest.fn(), write: writeSpy, end: jest.fn(), destroy: jest.fn() };
      });
    }

    function unlockedDetachedFs() {
      fs.existsSync.mockImplementation((p: string) =>
        p === runner.DETACHED_DIR ||
        (typeof p === 'string' && (p.includes('.done.json') || p.endsWith('.log') || p.endsWith('.json')))
      );
    }

    const WAIT_TASKS = ['SOT-940', 'SOT-941', 'SOT-942'];

    it('launches several wait tasks detached, each freeing the lane immediately (no blocking await)', async () => {
      const children: any[] = [];
      for (let i = 0; i < WAIT_TASKS.length; i++) {
        const id = WAIT_TASKS[i];
        fs.existsSync.mockReturnValue(false);
        children.push(mockDetachedSpawn(54000 + i));
        setupLinearMocks([
          { issue: { id, state: { type: 'started', name: 'In Progress' }, labels: { nodes: [{ name: 'long-run' }] } } },
          { issue: { project: { name: 'ai-dev-control-plane' } } }
        ]);

        const outcome = await runner.runItem(queueItem(id) as any);

        // Returned WITHOUT awaiting the still-running child → the lane is not held for the wait duration.
        expect(outcome).toEqual({ lockConflict: false, detached: true });
      }

      // One detached spawn per wait task, all fire-and-forget.
      expect(spawn).toHaveBeenCalledTimes(WAIT_TASKS.length);
      for (let i = 0; i < WAIT_TASKS.length; i++) {
        const spawnOpts: any = (spawn as jest.Mock).mock.calls[i][2];
        expect(spawnOpts.detached).toBe(true);
        expect(spawnOpts.stdio).toBe('ignore');
        expect(children[i].unref).toHaveBeenCalled();
        // A per-issue sentinel was written for each wait task.
        const sentinelWrites = (fs.writeFileSync as jest.Mock).mock.calls
          .filter(c => typeof c[0] === 'string' && (c[0] as string).includes(`${WAIT_TASKS[i]}.json`));
        expect(sentinelWrites.length).toBeGreaterThan(0);
      }
    });

    it('runs wait tasks on independent lanes concurrently while the same lane stays serial', () => {
      // Distinct lanes → distinct lock + queue paths, so two wait tasks on different lanes never share a
      // lock (they can be in-flight simultaneously).
      const lanes = [runner.LOCK_FILE, runner.laneLockFile('sim'), runner.laneLockFile('build')];
      expect(new Set(lanes).size).toBe(3);
      const queues = [runner.QUEUE_FILE, runner.laneQueueFile('sim'), runner.laneQueueFile('build')];
      expect(new Set(queues).size).toBe(3);
      for (const p of [...lanes, ...queues]) {
        expect(p.startsWith(runner.LOG_DIR)).toBe(true);
        expect(p.includes('..')).toBe(false);
      }

      // The default lane preserves the historical single-lane paths (backward compatible).
      expect(runner.laneLockFile()).toBe(runner.LOCK_FILE);
      expect(runner.laneLockFile('default')).toBe(runner.LOCK_FILE);
      expect(runner.laneQueueFile()).toBe(runner.QUEUE_FILE);

      // Same lane → same lock/queue file: work on one lane is serialized through a single lock.
      expect(runner.laneLockFile('sim')).toBe(runner.laneLockFile('sim'));
      expect(runner.laneQueueFile('sim')).toBe(runner.laneQueueFile('sim'));
    });

    it('reaps several completed wait tasks in one sweep with mixed outcomes (success / usage-limit / fail)', async () => {
      unlockedDetachedFs();
      fs.readdirSync.mockReturnValue(WAIT_TASKS.map(id => `${id}.done.json`));
      const now = new Date().toISOString();
      fs.readFileSync.mockImplementation((p: string) => {
        // Match .done.json BEFORE .log (a done-marker path also contains ".json").
        if (p.includes('SOT-940.done.json')) return JSON.stringify({ issueId: 'SOT-940', exitCode: 0, endedAt: now });
        if (p.includes('SOT-941.done.json')) return JSON.stringify({ issueId: 'SOT-941', exitCode: 1, endedAt: now });
        if (p.includes('SOT-942.done.json')) return JSON.stringify({ issueId: 'SOT-942', exitCode: 1, endedAt: now });
        if (p.includes('SOT-940') && p.endsWith('.log')) return 'all good';
        // model_unavailable is retryable → Resume re-enqueue path.
        if (p.includes('SOT-941') && p.endsWith('.log')) return 'Error: the model is currently unavailable, please retry';
        if (p.includes('SOT-942') && p.endsWith('.log')) return 'fatal: boom';
        return '[]';
      });
      setupLinearAlwaysCompleted();

      const processed = await runner.reapCompletedDetachedRuns();

      // All three wait tasks drained in a single sweep.
      expect(processed).toEqual(expect.arrayContaining(WAIT_TASKS));
      expect(processed.length).toBe(WAIT_TASKS.length);

      // Each done-marker cleaned up after post-processing.
      for (const id of WAIT_TASKS) {
        expect(fs.unlinkSync).toHaveBeenCalledWith(runner.detachedDoneFile(id));
      }

      // The usage-limited wait task was re-injected into the Resume queue.
      const queueWrites = (fs.writeFileSync as jest.Mock).mock.calls
        .filter(c => typeof c[0] === 'string' && (c[0] as string).includes('runner.queue.json'));
      expect(queueWrites.length).toBeGreaterThan(0);
      expect(queueWrites.some(c => (c[1] as string).includes('SOT-941'))).toBe(true);
    });
  });

  // SOT-933: N-slot parallel worker pool (RUNNER_MAX_PARALLEL). Verifies (1) N=1 stays fully serial
  // (current-compatible), (2) N>1 dispatches DISTINCT lanes concurrently so queue waiting is freed,
  // (3) the SAME lane (= same branch / same repo) is always kept serial (safety valve).
  describe('N-slot parallel pool (SOT-933)', () => {
    const flush = () => new Promise((r) => setImmediate(r));

    // A runOne whose entries resolve only when explicitly released — lets us observe concurrency.
    function makeControllable() {
      const releases = new Map<string, () => void>();
      const started: string[] = [];
      const activeByLane = new Map<string, number>();
      let concurrent = 0;
      let maxConcurrent = 0;
      let laneViolation = false;
      const runOne = (entry: any): Promise<void> => {
        started.push(entry.id);
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        const laneCount = (activeByLane.get(entry.lane) || 0) + 1;
        activeByLane.set(entry.lane, laneCount);
        if (laneCount > 1) laneViolation = true; // two of the same lane in-flight at once
        return new Promise<void>((resolve) => {
          releases.set(entry.id, () => {
            concurrent--;
            activeByLane.set(entry.lane, (activeByLane.get(entry.lane) || 1) - 1);
            resolve();
          });
        });
      };
      return {
        runOne,
        releases,
        started,
        get maxConcurrent() { return maxConcurrent; },
        get laneViolation() { return laneViolation; },
      };
    }

    it('resolveMaxParallel defaults to 1 and clamps invalid/empty/<1 to 1', () => {
      expect(runner.resolveMaxParallel({})).toBe(1);
      expect(runner.resolveMaxParallel({ RUNNER_MAX_PARALLEL: '' })).toBe(1);
      expect(runner.resolveMaxParallel({ RUNNER_MAX_PARALLEL: '0' })).toBe(1);
      expect(runner.resolveMaxParallel({ RUNNER_MAX_PARALLEL: '-3' })).toBe(1);
      expect(runner.resolveMaxParallel({ RUNNER_MAX_PARALLEL: 'abc' })).toBe(1);
      expect(runner.resolveMaxParallel({ RUNNER_MAX_PARALLEL: '4' })).toBe(4);
    });

    it('maxParallel=1 runs strictly serially even across distinct lanes (current-compatible)', async () => {
      const ctl = makeControllable();
      const items = [
        { id: 'A', lane: 'repoA' },
        { id: 'B', lane: 'repoB' },
        { id: 'C', lane: 'repoC' },
      ];
      const done = runner.runLanePool(items, 1, ctl.runOne);
      await flush();
      expect(ctl.started).toEqual(['A']); // only one in-flight
      ctl.releases.get('A')!();
      await flush();
      expect(ctl.started).toEqual(['A', 'B']);
      ctl.releases.get('B')!();
      await flush();
      expect(ctl.started).toEqual(['A', 'B', 'C']);
      ctl.releases.get('C')!();
      await done;
      expect(ctl.maxConcurrent).toBe(1);
    });

    it('N>1 dispatches distinct lanes concurrently (≤ N) while same-lane stays serial & in order', async () => {
      const ctl = makeControllable();
      const items = [
        { id: 'A', lane: 'repoA' },
        { id: 'B', lane: 'repoB' },
        { id: 'C', lane: 'repoA' }, // same lane as A → must wait for A (safety valve)
        { id: 'D', lane: 'repoC' },
      ];
      const done = runner.runLanePool(items, 2, ctl.runOne);

      await flush();
      // Two free slots: A(repoA) and B(repoB) start; C(repoA) is blocked; D waits for a slot.
      expect(ctl.started).toEqual(['A', 'B']);

      ctl.releases.get('A')!(); // frees a slot AND lane repoA
      await flush();
      // Next dispatchable is C (repoA now free) — same-lane order A→C preserved.
      expect(ctl.started).toEqual(['A', 'B', 'C']);

      ctl.releases.get('B')!(); // frees a slot
      await flush();
      expect(ctl.started).toEqual(['A', 'B', 'C', 'D']);

      ctl.releases.get('C')!();
      ctl.releases.get('D')!();
      await done;

      expect(ctl.maxConcurrent).toBeLessThanOrEqual(2); // never exceeded the slot count
      expect(ctl.laneViolation).toBe(false);            // same lane never ran concurrently
    });

    it('a single lane with many items is fully serial regardless of a high slot count', async () => {
      const ctl = makeControllable();
      const items = [
        { id: 'A', lane: 'repoX' },
        { id: 'B', lane: 'repoX' },
        { id: 'C', lane: 'repoX' },
      ];
      const done = runner.runLanePool(items, 5, ctl.runOne);
      await flush();
      expect(ctl.started).toEqual(['A']);
      ctl.releases.get('A')!();
      await flush();
      expect(ctl.started).toEqual(['A', 'B']);
      ctl.releases.get('B')!();
      await flush();
      expect(ctl.started).toEqual(['A', 'B', 'C']);
      ctl.releases.get('C')!();
      await done;
      expect(ctl.maxConcurrent).toBe(1);
      expect(ctl.laneViolation).toBe(false);
    });

    it('resolveConcurrencyLane falls back to the shared default lane when the repo is unknown', async () => {
      process.env.LINEAR_API_KEY = 'test-key';
      // getIssueProjectName → no project mapping → DEFAULT_LANE (such items serialize together).
      (https.request as jest.Mock).mockImplementation((_options: any, callback: any) => {
        const responseData = JSON.stringify({ data: { issue: { project: null } } });
        const res: any = {
          on: jest.fn((event: any, cb: any) => {
            if (event === 'data') cb(responseData);
            if (event === 'end') cb();
          })
        };
        callback(res);
        return { on: jest.fn(), write: jest.fn(), end: jest.fn(), destroy: jest.fn() };
      });
      const lane = await runner.resolveConcurrencyLane({ issueId: 'SOT-999', trigger: 'webhook' } as any);
      expect(lane).toBe(runner.DEFAULT_LANE);
    });
  });
});
