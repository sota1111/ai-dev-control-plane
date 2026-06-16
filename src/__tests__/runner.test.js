const fs = require('fs');
const https = require('https');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const runner = require('../runner');

jest.mock('fs');
jest.mock('https');
jest.mock('child_process', () => ({
  spawn: jest.fn()
}));

describe('runner', () => {
  const mockLockFile = runner.LOCK_FILE;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process, 'kill').mockImplementation(() => true);
    // Default mock for existsSync
    fs.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('acquireLock', () => {
    it('returns true when lock file does not exist', () => {
      fs.existsSync.mockImplementation((path) => path === runner.LOG_DIR); // log dir exists, lock file doesn't
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
      process.kill.mockImplementation(() => {
        const err = new Error('Process not found');
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
      fs.existsSync.mockImplementation((path) => path === runner.COOLDOWN_FILE);
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
      fs.existsSync.mockImplementation((path) => 
        path === runner.COOLDOWN_FILE || path === runner.USAGE_LIMIT_FILE
      );
      fs.readFileSync.mockReturnValue(JSON.stringify({ until: retryAt }));

      expect(runner.getUsageLimitCooldownUntil()).toBe(null);
      expect(fs.unlinkSync).toHaveBeenCalledWith(runner.COOLDOWN_FILE);
      expect(fs.unlinkSync).toHaveBeenCalledWith(runner.USAGE_LIMIT_FILE);
    });
  });


  describe('queue management', () => {
    function setupQueueState(initialQueue, { lockHeld = false } = {}) {
      let currentQueue = initialQueue.map(item => ({ ...item }));

      fs.existsSync.mockImplementation((path) => (
        path === runner.LOG_DIR
        || path === runner.QUEUE_FILE
        || (lockHeld && path === runner.LOCK_FILE)
      ));
      fs.readFileSync.mockImplementation((path) => {
        if (path === runner.QUEUE_FILE) return JSON.stringify(currentQueue);
        if (path === runner.LOCK_FILE) return `${process.pid + 1}:${new Date().toISOString()}`;
        return '';
      });
      fs.writeFileSync.mockImplementation((path, content) => {
        if (path === `${runner.QUEUE_FILE}.tmp`) {
          currentQueue = JSON.parse(content);
        }
      });

      return {
        getQueue: () => currentQueue.map(item => ({ ...item }))
      };
    }

    function queueItem(issueId, priority, extra = {}) {
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

    function mockRunAutoExit(code, output = '') {
      spawn.mockImplementation(() => {
        const child = new EventEmitter();
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
        expect.not.stringContaining('SOT-1')
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
    let writeSpy;

    beforeEach(() => {
      jest.clearAllMocks();
      process.env.LINEAR_API_KEY = 'test-key';
      writeSpy = jest.fn();
    });

    function setupLinearMocks(responses) {
      let index = 0;
      https.request.mockImplementation((options, callback) => {
        const responseData = JSON.stringify({ data: responses[index++] });
        const res = {
          on: jest.fn((event, cb) => {
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
      const writtenBodies = writeSpy.mock.calls.map(c => c[0]);
      expect(writtenBodies.some(b => b.includes('commentCreate'))).toBe(false);
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
      const writtenBodies = writeSpy.mock.calls.map(c => c[0]);
      expect(writtenBodies.some(b => b.includes('commentCreate'))).toBe(true);
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
      const writtenBodies = writeSpy.mock.calls.map(c => c[0]);
      expect(writtenBodies.some(b => b.includes('commentCreate'))).toBe(true);
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
    let writeSpy;
    beforeEach(() => {
      writeSpy = jest.fn();
    });

    function setupLinearMocks(responses) {
      let index = 0;
      https.request.mockImplementation((options, callback) => {
        const responseData = JSON.stringify({ data: responses[index++] });
        const res = {
          on: jest.fn((event, cb) => {
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
      const writeCalls = fs.writeFileSync.mock.calls.filter(c => c[0].includes('runner.queue.json.tmp'));
      // If writeFileSync was called, it should still contain SOT-ACTIVE
      if (writeCalls.length > 0) {
        expect(writeCalls[writeCalls.length - 1][1]).toContain('SOT-ACTIVE');
      }
    });

    it('fail-open: keeps item on API error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-ERROR' }]));
      https.request.mockImplementation((options, callback) => {
        const req = new EventEmitter();
        req.write = jest.fn();
        req.end = jest.fn();
        process.nextTick(() => req.emit('error', new Error('API down')));
        return req;
      });

      await runner.syncQueueWithLinear();

      const writeCalls = fs.writeFileSync.mock.calls.filter(c => c[0].includes('runner.queue.json.tmp'));
      expect(writeCalls.length).toBe(0); // Should not save cleaned queue
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
      
      fs.existsSync.mockImplementation((path) => path === runner.INFLIGHT_FILE);
      fs.readFileSync.mockReturnValue(JSON.stringify(['SOT-1']));
      expect(runner.isInflight('SOT-1')).toBe(true);
    });

    it('removeInflight works', () => {
      fs.existsSync.mockImplementation((path) => path === runner.INFLIGHT_FILE);
      fs.readFileSync.mockReturnValue(JSON.stringify(['SOT-1', 'SOT-2']));
      
      runner.removeInflight('SOT-1');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('runner.inflight.json.tmp'),
        expect.stringContaining('SOT-2')
      );
    });

    it('isQueuedOrRunning returns true if queued', () => {
      fs.existsSync.mockImplementation((path) => path === runner.QUEUE_FILE);
      fs.readFileSync.mockReturnValue(JSON.stringify([{ issueId: 'SOT-1' }]));
      expect(runner.isQueuedOrRunning('SOT-1')).toBe(true);
    });

    it('isQueuedOrRunning returns true if inflight', () => {
      fs.existsSync.mockImplementation((path) => path === runner.INFLIGHT_FILE);
      fs.readFileSync.mockReturnValue(JSON.stringify(['SOT-1']));
      expect(runner.isQueuedOrRunning('SOT-1')).toBe(true);
    });
  });

  describe('pruneExpiredQueueItems', () => {
    let writeSpy;
    beforeEach(() => {
      writeSpy = jest.fn();
    });

    function setupLinearMocks(responses) {
      let index = 0;
      https.request.mockImplementation((options, callback) => {
        const responseData = JSON.stringify({ data: responses[index++] });
        const res = {
          on: jest.fn((event, cb) => {
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

      const writeCalls = fs.writeFileSync.mock.calls.filter(c => c[0].includes('runner.queue.json.tmp'));
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
      https.request.mockImplementation(() => {
        const req = new EventEmitter();
        req.write = jest.fn();
        req.end = jest.fn();
        process.nextTick(() => req.emit('error', new Error('Linear unavailable')));
        return req;
      });

      await runner.pruneExpiredQueueItems();

      const writeCalls = fs.writeFileSync.mock.calls.filter(c => c[0].includes('runner.queue.json.tmp'));
      expect(writeCalls.length).toBe(0);
    });
  });
});
