import {
  resolveRepoForProject,
  deriveRepoForProject,
  loadProjectRepoConfig,
  ProjectRepo,
} from '../lib/projectRepo.js';

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

  });
});

describe('deriveRepoForProject (auto-linking by naming convention)', () => {
  test('derives a mapping when the checkout exists', () => {
    const r = deriveRepoForProject('sample-service', { exists: () => true });
    expect(r).toEqual({
      project: 'sample-service',
      repo: 'sota1111/sample-service',
      localPath: '/workspaces/sample-service',
    });
  });


  test('slugifies the project name and honors overrides', () => {
    const r = deriveRepoForProject('  My Cool Project  ', {
      exists: (p) => p === '/repos/my-cool-project',
      workspaceRoot: '/repos',
      owner: 'acme',
    });
    expect(r).toEqual({
      project: 'My Cool Project',
      repo: 'acme/my-cool-project',
      localPath: '/repos/my-cool-project',
    });
  });

  test('returns null for empty / whitespace-only names', () => {
    expect(deriveRepoForProject('', { exists: () => true })).toBeNull();
    expect(deriveRepoForProject('   ', { exists: () => true })).toBeNull();
  });

});
