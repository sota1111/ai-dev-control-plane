const fs = require('fs');
const https = require('https');
const runner = require('../runner');

jest.mock('fs');
jest.mock('https');

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
});
