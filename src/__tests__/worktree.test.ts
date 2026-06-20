import { jest } from '@jest/globals';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';

import * as worktree from '../lib/worktree.js';

describe('worktree lane provisioning (SOT-932)', () => {
  describe('pure path derivation', () => {
    it('default base dir is a sibling .runner-worktrees/<repo> outside the repo', () => {
      const base = worktree.laneWorktreeBaseDir('/workspaces/booking-monitor', {});
      expect(base).toBe('/workspaces/.runner-worktrees/booking-monitor');
    });

    it('RUNNER_WORKTREE_BASE override still appends the repo name', () => {
      const base = worktree.laneWorktreeBaseDir('/workspaces/booking-monitor', {
        RUNNER_WORKTREE_BASE: '/tmp/wt',
      });
      expect(base).toBe('/tmp/wt/booking-monitor');
    });

    it('different lanes derive different worktree paths', () => {
      const repoRoot = '/workspaces/booking-monitor';
      const a = worktree.laneWorktreePath({ repoRoot, lane: 'booking-monitor--feat-a' });
      const b = worktree.laneWorktreePath({ repoRoot, lane: 'booking-monitor--feat-b' });
      expect(a).not.toBe(b);
      expect(a).toContain('booking-monitor--feat-a');
    });

    it('sanitizes the lane so the path cannot escape the base dir', () => {
      const repoRoot = '/workspaces/booking-monitor';
      const base = worktree.laneWorktreeBaseDir(repoRoot, {});
      const p = worktree.laneWorktreePath({ repoRoot, lane: '../../etc/passwd' });
      expect(p.startsWith(base + path.sep)).toBe(true);
      expect(p).not.toContain('..');
    });

    it('lane branch name is deterministic and lane-safe', () => {
      expect(worktree.laneWorktreeBranch('booking-monitor--feat/a')).toBe(
        'runner/lane/booking-monitor--feata'
      );
    });
  });

  describe('provisionLaneWorktree with injected exec', () => {
    it('default lane uses no worktree and returns repoRoot unchanged', () => {
      const exec = jest.fn(() => '');
      const res = worktree.provisionLaneWorktree(
        { repoRoot: '/workspaces/booking-monitor', lane: 'default', exec: exec as any },
        {}
      );
      expect(res).toEqual({ path: '/workspaces/booking-monitor', created: false, worktree: false });
      expect(exec).not.toHaveBeenCalled();
    });

    it('empty lane is treated as default (no worktree)', () => {
      const exec = jest.fn(() => '');
      const res = worktree.provisionLaneWorktree(
        { repoRoot: '/workspaces/booking-monitor', lane: '', exec: exec as any },
        {}
      );
      expect(res.worktree).toBe(false);
      expect(res.path).toBe('/workspaces/booking-monitor');
      expect(exec).not.toHaveBeenCalled();
    });

    it('branch-scope lanes A and B get two distinct worktrees via two add calls', () => {
      const repoRoot = '/workspaces/booking-monitor';
      const calls: string[] = [];
      const exec = ((cmd: string) => {
        calls.push(cmd);
        return ''; // worktree list -> empty; existsSync(false) below
      }) as any;
      const env = { RUNNER_WORKTREE_BASE: '/tmp/wt' };
      const a = worktree.provisionLaneWorktree(
        { repoRoot, lane: 'booking-monitor--feat-a', exec },
        env
      );
      const b = worktree.provisionLaneWorktree(
        { repoRoot, lane: 'booking-monitor--feat-b', exec },
        env
      );
      expect(a.path).not.toBe(b.path);
      expect(a.created).toBe(true);
      expect(b.created).toBe(true);
      const adds = calls.filter((c) => c.includes('worktree add'));
      expect(adds).toHaveLength(2);
    });

    it('is idempotent: a registered worktree is reused without a second add', () => {
      const repoRoot = '/workspaces/booking-monitor';
      const env = { RUNNER_WORKTREE_BASE: '/tmp/wt' };
      const wtPath = worktree.laneWorktreePath(
        { repoRoot, lane: 'booking-monitor--feat-a' },
        env
      );
      const calls: string[] = [];
      const exec = ((cmd: string) => {
        calls.push(cmd);
        if (cmd.includes('worktree list')) {
          // Report the lane worktree as already registered.
          return `worktree ${repoRoot}\n\nworktree ${wtPath}\n`;
        }
        return '';
      }) as any;
      const res = worktree.provisionLaneWorktree(
        { repoRoot, lane: 'booking-monitor--feat-a', exec },
        env
      );
      expect(res).toEqual({ path: wtPath, created: false, worktree: true });
      expect(calls.some((c) => c.includes('worktree add'))).toBe(false);
    });
  });

  describe('real git integration', () => {
    let tmp: string;
    let repoRoot: string;

    const git = (cwd: string, args: string) =>
      execSync(`git -C ${JSON.stringify(cwd)} ${args}`, { encoding: 'utf8' });

    beforeAll(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sot932-'));
      repoRoot = path.join(tmp, 'repo');
      fs.mkdirSync(repoRoot, { recursive: true });
      git(repoRoot, 'init -q');
      git(repoRoot, 'config user.email t@t.test');
      git(repoRoot, 'config user.name tester');
      git(repoRoot, 'config commit.gpgsign false');
      fs.writeFileSync(path.join(repoRoot, 'README.md'), 'base\n');
      git(repoRoot, 'add -A');
      git(repoRoot, 'commit -q -m init');
    });

    afterAll(() => {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('provisions two isolated worktrees for two branches without corrupting each other', () => {
      const baseDir = path.join(tmp, 'wt');
      const laneA = 'repo--feat-a';
      const laneB = 'repo--feat-b';

      const a = worktree.provisionLaneWorktree({ repoRoot, lane: laneA, baseDir }, {});
      const b = worktree.provisionLaneWorktree({ repoRoot, lane: laneB, baseDir }, {});

      expect(a.created).toBe(true);
      expect(b.created).toBe(true);
      expect(a.path).not.toBe(b.path);
      expect(fs.existsSync(a.path)).toBe(true);
      expect(fs.existsSync(b.path)).toBe(true);

      const list = git(repoRoot, 'worktree list --porcelain');
      expect(list).toContain(path.resolve(a.path));
      expect(list).toContain(path.resolve(b.path));

      // Writing in each worktree does not corrupt the other.
      fs.writeFileSync(path.join(a.path, 'a.txt'), 'A\n');
      fs.writeFileSync(path.join(b.path, 'b.txt'), 'B\n');
      expect(fs.existsSync(path.join(a.path, 'b.txt'))).toBe(false);
      expect(fs.existsSync(path.join(b.path, 'a.txt'))).toBe(false);

      // The main repo working tree is untouched.
      expect(fs.existsSync(path.join(repoRoot, 'a.txt'))).toBe(false);
      expect(fs.existsSync(path.join(repoRoot, 'b.txt'))).toBe(false);
    });

    it('re-provisioning the same lane is idempotent (reuse, no error)', () => {
      const baseDir = path.join(tmp, 'wt');
      const lane = 'repo--feat-a';
      const again = worktree.provisionLaneWorktree({ repoRoot, lane, baseDir }, {});
      expect(again.worktree).toBe(true);
      expect(again.created).toBe(false);
    });

    it('removeLaneWorktree cleans up and is idempotent', () => {
      const baseDir = path.join(tmp, 'wt');
      const lane = 'repo--feat-b';
      const wtPath = worktree.laneWorktreePath({ repoRoot, lane, baseDir }, {});
      expect(fs.existsSync(wtPath)).toBe(true);

      const first = worktree.removeLaneWorktree({ repoRoot, lane, baseDir }, {});
      expect(first.removed).toBe(true);
      expect(fs.existsSync(wtPath)).toBe(false);

      // Second remove is a safe no-op.
      const second = worktree.removeLaneWorktree({ repoRoot, lane, baseDir }, {});
      expect(second.removed).toBe(false);
    });

    it('default lane never creates a worktree even with real git', () => {
      const res = worktree.provisionLaneWorktree({ repoRoot, lane: 'default' }, {});
      expect(res.worktree).toBe(false);
      expect(res.path).toBe(repoRoot);
    });
  });
});
