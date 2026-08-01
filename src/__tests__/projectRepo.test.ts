import {
  resolveRepoForProject,
  loadProjectRepoConfig,
  ProjectRepo,
} from '../lib/projectRepo.js';
import fs from 'node:fs';
import path from 'node:path';

const fixture: ProjectRepo[] = [
  { project: 'ai-dev-control-plane', repo: 'sota1111/ai-dev-control-plane', localPath: '/workspaces/ai-dev-control-plane' },
  { project: 'booking-monitor', repo: 'sota1111/booking-monitor', localPath: '/workspaces/booking-monitor' },
];

describe('resolveRepoForProject (with explicit config)', () => {
  test('resolves a known app project', () => {
    const r = resolveRepoForProject('booking-monitor', fixture);
    expect(r).not.toBeNull();
    expect(r?.localPath).toBe('/workspaces/booking-monitor');
  });

  test('resolves the control-plane project', () => {
    const r = resolveRepoForProject('ai-dev-control-plane', fixture);
    expect(r?.localPath).toBe('/workspaces/ai-dev-control-plane');
  });

  test('returns null for an unknown project', () => {
    expect(resolveRepoForProject('does-not-exist', fixture)).toBeNull();
  });

  test('trims whitespace and ignores case', () => {
    const r = resolveRepoForProject('  Booking-Monitor  ', fixture);
    expect(r?.localPath).toBe('/workspaces/booking-monitor');
  });

  test('returns null for empty / whitespace-only project name', () => {
    expect(resolveRepoForProject('', fixture)).toBeNull();
    expect(resolveRepoForProject('   ', fixture)).toBeNull();
  });
});

describe('loadProjectRepoConfig (real config/project_repos.json)', () => {
  test('returns a non-empty array including the control-plane entry', () => {
    const config = loadProjectRepoConfig();
    expect(Array.isArray(config)).toBe(true);
    expect(config.length).toBeGreaterThan(0);
    const cp = config.find((e) => e.project === 'ai-dev-control-plane');
    expect(cp).toBeDefined();
    expect(cp?.localPath).toBe('/workspaces/ai-dev-control-plane');
  });

  test('every entry has a non-empty project and localPath', () => {
    for (const e of loadProjectRepoConfig()) {
      expect(typeof e.project).toBe('string');
      expect(e.project.length).toBeGreaterThan(0);
      expect(typeof e.localPath).toBe('string');
      expect(e.localPath.length).toBeGreaterThan(0);
    }
  });

  test('maps every project used by the Kaggle cycle registry', () => {
    const registry = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'scripts/ai/kaggle_targets_registry.json'),
      'utf8',
    ));
    const projects = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (typeof record.project === 'string') projects.add(record.project);
      Object.values(record).forEach(visit);
    };
    visit(registry);
    const mapped = new Set(loadProjectRepoConfig().map((entry) => entry.project));
    expect([...projects].filter((project) => !mapped.has(project))).toEqual([]);
  });

  test('local Kaggle artifacts come from the same checkout that improvement issues modify', () => {
    const registry = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'scripts/ai/kaggle_targets_registry.json'),
      'utf8',
    ));
    const mappings = new Map(loadProjectRepoConfig().map((entry) => [entry.project, entry]));
    const scheduledCompetitionKeys = new Set(
      (registry.rotation ?? []).map((slot: { competition: string }) => slot.competition),
    );
    for (const competition of registry.competitions ?? []) {
      if (!scheduledCompetitionKeys.has(competition.key)) continue;
      for (const target of competition.targets ?? []) {
        const submit = target.submit ?? {};
        // Notebook submissions are immutable Kaggle outputs rather than files built by the checkout.
        if (!submit.file || submit.kernel) continue;
        const mapping = mappings.get(target.project);
        expect(mapping).toBeDefined();
        const artifact = path.resolve(process.cwd(), submit.file);
        const repoRoot = path.resolve(mapping!.localPath);
        expect(artifact === repoRoot || artifact.startsWith(`${repoRoot}${path.sep}`)).toBe(true);
      }
    }
  });
});

describe('resolveRepoForProject (default config load)', () => {
  test('resolves a real project from the on-disk config', () => {
    const r = resolveRepoForProject('ai-dev-control-plane');
    expect(r?.localPath).toBe('/workspaces/ai-dev-control-plane');
  });
});
