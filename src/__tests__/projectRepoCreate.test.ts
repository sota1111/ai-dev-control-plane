import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isNewProject,
  slugify,
  deriveNewRepoName,
  upsertProjectRepoEntry,
  persistProjectRepoMapping,
  ensureRepoForNewProject,
  RunResult,
} from '../lib/projectRepoCreate.js';
import { ProjectRepo } from '../lib/projectRepo.js';

describe('isNewProject', () => {
  test('matches the "New" marker case/space-insensitively', () => {
    expect(isNewProject('New')).toBe(true);
    expect(isNewProject(' new ')).toBe(true);
    expect(isNewProject('NEW')).toBe(true);
  });
  test('rejects other / empty / nullish project names', () => {
    expect(isNewProject('booking-monitor')).toBe(false);
    expect(isNewProject('')).toBe(false);
    expect(isNewProject(null)).toBe(false);
    expect(isNewProject(undefined)).toBe(false);
  });
});

describe('slugify', () => {
  test('lowercases and hyphenates non-alphanumerics', () => {
    expect(slugify('Todo App!')).toBe('todo-app');
    expect(slugify('foo  bar')).toBe('foo-bar');
    expect(slugify('My_Cool.Repo')).toBe('my-cool-repo');
  });
  test('trims and collapses hyphens', () => {
    expect(slugify('--Hello--World--')).toBe('hello-world');
  });
  test('returns empty for non-ascii-only input', () => {
    expect(slugify('日本語タイトル')).toBe('');
  });
});

describe('deriveNewRepoName', () => {
  test('explicit `repo:` directive in body wins', () => {
    expect(
      deriveNewRepoName({ title: 'something else', identifier: 'SOT-1', body: 'intro\nrepo: my-app\nmore' })
    ).toBe('my-app');
  });
  test('falls back to the title slug', () => {
    expect(deriveNewRepoName({ title: 'Todo App', identifier: 'SOT-860' })).toBe('todo-app');
  });
  test('falls back to new-<identifier> when title is non-ascii', () => {
    expect(deriveNewRepoName({ title: '日本語タイトル', identifier: 'SOT-860' })).toBe('new-sot-860');
  });
  test('final fallback is new-repo', () => {
    expect(deriveNewRepoName({ title: '日本語', identifier: '' })).toBe('new-repo');
    expect(deriveNewRepoName({})).toBe('new-repo');
  });
});

describe('upsertProjectRepoEntry', () => {
  const base: ProjectRepo[] = [
    { project: 'booking-monitor', repo: 'sota1111/booking-monitor', localPath: '/workspaces/booking-monitor' },
  ];
  test('appends a new entry', () => {
    const next = upsertProjectRepoEntry(base, {
      project: 'todo-app',
      repo: 'sota1111/todo-app',
      localPath: '/workspaces/todo-app',
    });
    expect(next).toHaveLength(2);
    expect(next.find((e) => e.project === 'todo-app')).toBeDefined();
  });
  test('replaces an existing entry case-insensitively without mutating input', () => {
    const next = upsertProjectRepoEntry(base, {
      project: 'Booking-Monitor',
      repo: 'sota1111/booking-monitor',
      localPath: '/new/path',
    });
    expect(next).toHaveLength(1);
    expect(next[0].localPath).toBe('/new/path');
    // input untouched
    expect(base[0].localPath).toBe('/workspaces/booking-monitor');
  });
});

describe('persistProjectRepoMapping', () => {
  let tmpDir: string;
  let configPath: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prm-'));
    configPath = path.join(tmpDir, 'project_repos.json');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('appends a new mapping and returns true', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify([{ project: 'existing', repo: 'sota1111/existing', localPath: '/workspaces/existing' }]),
    );
    const wrote = persistProjectRepoMapping(
      { project: 'ptcg-agent-obo', repo: 'sota1111/ptcg-agent-obo', localPath: '/workspaces/ptcg-agent-obo' },
      configPath,
    );
    expect(wrote).toBe(true);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(saved.find((e: ProjectRepo) => e.project === 'ptcg-agent-obo')?.localPath).toBe(
      '/workspaces/ptcg-agent-obo',
    );
  });

  test('does not overwrite an existing project and returns false', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify([{ project: 'Ptcg-Agent-Obo', repo: 'sota1111/x', localPath: '/keep' }]),
    );
    const wrote = persistProjectRepoMapping(
      { project: 'ptcg-agent-obo', repo: 'sota1111/ptcg-agent-obo', localPath: '/new' },
      configPath,
    );
    expect(wrote).toBe(false);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].localPath).toBe('/keep');
  });

  test('creates the config when it does not exist yet', () => {
    const wrote = persistProjectRepoMapping(
      { project: 'brand-new', repo: 'sota1111/brand-new', localPath: '/workspaces/brand-new' },
      configPath,
    );
    expect(wrote).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toHaveLength(1);
  });
});

describe('ensureRepoForNewProject (injected runner, no real gh/git)', () => {
  let tmpDir: string;
  let configPath: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-'));
    configPath = path.join(tmpDir, 'project_repos.json');
    workspaceRoot = path.join(tmpDir, 'workspaces');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify([], null, 2) + '\n', 'utf8');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('skips gh repo create when the repo already exists', async () => {
    const calls: string[][] = [];
    const run = (cmd: string, args: string[]): RunResult => {
      calls.push([cmd, ...args]);
      if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') return { code: 0, stdout: '{}', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    // pre-create localPath so no clone/commit is attempted
    const localPath = path.join(workspaceRoot, 'existing-app');
    fs.mkdirSync(localPath, { recursive: true });
    fs.writeFileSync(path.join(localPath, 'README.md'), '# existing-app\n', 'utf8');

    const result = await ensureRepoForNewProject({
      repoName: 'existing-app',
      workspaceRoot,
      configPath,
      run,
    });

    expect(result.created).toBe(false);
    expect(result.repo).toBe('sota1111/existing-app');
    expect(calls.some((c) => c[0] === 'gh' && c[2] === 'create')).toBe(false);
    // config got the entry
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(cfg.find((e: ProjectRepo) => e.project === 'existing-app')).toBeDefined();
  });

  test('calls gh repo create when the repo does not exist', async () => {
    const calls: string[][] = [];
    const run = (cmd: string, args: string[]): RunResult => {
      calls.push([cmd, ...args]);
      if (cmd === 'gh' && args[1] === 'view') return { code: 1, stdout: '', stderr: 'not found' };
      if (cmd === 'git' && args[0] === 'clone') {
        // simulate clone creating the directory
        fs.mkdirSync(path.join(workspaceRoot, 'fresh-app'), { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };

    const result = await ensureRepoForNewProject({
      repoName: 'fresh-app',
      workspaceRoot,
      configPath,
      run,
    });

    expect(result.created).toBe(true);
    expect(calls.some((c) => c[0] === 'gh' && c[2] === 'create' && c.includes('--public'))).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(cfg.find((e: ProjectRepo) => e.project === 'fresh-app')?.repo).toBe('sota1111/fresh-app');
  });

  test('throws (so caller can fail-open) when gh repo create fails', async () => {
    const run = (cmd: string, args: string[]): RunResult => {
      if (cmd === 'gh' && args[1] === 'view') return { code: 1, stdout: '', stderr: 'not found' };
      if (cmd === 'gh' && args[1] === 'create') return { code: 1, stdout: '', stderr: 'boom' };
      return { code: 0, stdout: '', stderr: '' };
    };
    await expect(
      ensureRepoForNewProject({ repoName: 'bad-app', workspaceRoot, configPath, run })
    ).rejects.toThrow(/gh repo create/);
  });
});
