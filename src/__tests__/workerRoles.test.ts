import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WORKER_ROLES,
  WORKERS,
  loadWorkerRolesConfig,
  reorderChainForPin,
  resolveRoleChain,
  resolveRoleChainCli,
  resolveRoleWorker,
  resolveRoleWorkerCli,
} from '../lib/workerRoles.js';

function writeTmpConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-roles-'));
  const p = path.join(dir, 'worker_roles.json');
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// A valid config exercising both forms: chain arrays and a bare-string (single-element) chain.
const VALID = JSON.stringify({
  __doc__: 'ignored documentation key',
  'task-check': ['codex', 'claude', 'antigravity'],
  decomposition: ['claude', 'codex', 'antigravity'],
  implementation: ['antigravity', 'codex', 'claude'],
  verification: ['codex', 'claude'],
  acceptance: 'claude', // bare string == single-element chain (backward compatible)
  github: ['claude', 'codex', 'antigravity'],
  'linear-report': ['claude', 'codex', 'antigravity'],
});

describe('loadWorkerRolesConfig', () => {
  test('loads chains, normalizes a bare string, and ignores __ keys', () => {
    const p = writeTmpConfig(VALID);
    const cfg = loadWorkerRolesConfig(p);
    expect(cfg).toEqual({
      'task-check': ['codex', 'claude', 'antigravity'],
      decomposition: ['claude', 'codex', 'antigravity'],
      implementation: ['antigravity', 'codex', 'claude'],
      verification: ['codex', 'claude'],
      acceptance: ['claude'],
      github: ['claude', 'codex', 'antigravity'],
      'linear-report': ['claude', 'codex', 'antigravity'],
    });
  });

  test('de-duplicates repeated workers while preserving order', () => {
    const p = writeTmpConfig(
      JSON.stringify({
        'task-check': ['codex', 'codex', 'claude'],
        decomposition: 'claude',
        implementation: 'antigravity',
        verification: 'codex',
        acceptance: 'claude',
        github: 'claude',
        'linear-report': 'claude',
      }),
    );
    expect(resolveRoleChain('task-check', p)).toEqual(['codex', 'claude']);
  });

  test('the committed config/worker_roles.json is valid and every chain is non-empty', () => {
    const repoConfig = path.join(process.cwd(), 'config', 'worker_roles.json');
    const cfg = loadWorkerRolesConfig(repoConfig);
    for (const role of WORKER_ROLES) {
      expect(Array.isArray(cfg[role])).toBe(true);
      expect(cfg[role].length).toBeGreaterThan(0);
      for (const w of cfg[role]) expect(WORKERS).toContain(w);
    }
  });

  test('throws when file is missing', () => {
    expect(() => loadWorkerRolesConfig('/no/such/worker_roles.json')).toThrow(/not found/);
  });

  test('throws on invalid JSON', () => {
    const p = writeTmpConfig('{ not json');
    expect(() => loadWorkerRolesConfig(p)).toThrow(/not valid JSON/);
  });

  test('throws on an unknown role key', () => {
    const p = writeTmpConfig(JSON.stringify({ 'task-check': 'codex', bogus: 'codex' }));
    expect(() => loadWorkerRolesConfig(p)).toThrow(/unknown role "bogus"/);
  });

  test('throws on an invalid worker in a chain', () => {
    const p = writeTmpConfig(
      JSON.stringify({
        'task-check': ['gemini', 'codex'],
        decomposition: 'claude',
        implementation: 'antigravity',
        verification: 'codex',
        acceptance: 'claude',
        github: 'claude',
        'linear-report': 'claude',
      }),
    );
    expect(() => loadWorkerRolesConfig(p)).toThrow(/invalid worker/);
  });

  test('throws on an empty chain', () => {
    const p = writeTmpConfig(
      JSON.stringify({
        'task-check': [],
        decomposition: 'claude',
        implementation: 'antigravity',
        verification: 'codex',
        acceptance: 'claude',
        github: 'claude',
        'linear-report': 'claude',
      }),
    );
    expect(() => loadWorkerRolesConfig(p)).toThrow(/non-empty/);
  });

  test('throws when a required role is missing', () => {
    const p = writeTmpConfig(JSON.stringify({ 'task-check': 'codex' }));
    expect(() => loadWorkerRolesConfig(p)).toThrow(/missing role/);
  });
});

describe('resolveRoleChain', () => {
  test('returns the full ordered chain for a known role', () => {
    const p = writeTmpConfig(VALID);
    expect(resolveRoleChain('task-check', p)).toEqual(['codex', 'claude', 'antigravity']);
    expect(resolveRoleChain('verification', p)).toEqual(['codex', 'claude']);
    expect(resolveRoleChain('acceptance', p)).toEqual(['claude']);
  });

  test('returns [] for an unknown role and when the config is unreadable', () => {
    const p = writeTmpConfig(VALID);
    expect(resolveRoleChain('deploy', p)).toEqual([]);
    expect(resolveRoleChain('verification', '/no/such/worker_roles.json')).toEqual([]);
  });
});

describe('resolveRoleWorker (primary, backward compatible)', () => {
  test('returns the primary (chain[0]) for a known role', () => {
    const p = writeTmpConfig(VALID);
    expect(resolveRoleWorker('verification', p)).toBe('codex');
    expect(resolveRoleWorker('implementation', p)).toBe('antigravity');
    expect(resolveRoleWorker('acceptance', p)).toBe('claude');
  });

  test('returns null for an unknown role or unreadable config', () => {
    const p = writeTmpConfig(VALID);
    expect(resolveRoleWorker('deploy', p)).toBeNull();
    expect(resolveRoleWorker('verification', '/no/such/worker_roles.json')).toBeNull();
  });
});

describe('CLI helpers', () => {
  test('resolveRoleChainCli prints the space-separated chain, or empty string', () => {
    const p = writeTmpConfig(VALID);
    expect(resolveRoleChainCli(p, 'task-check')).toBe('codex claude antigravity');
    expect(resolveRoleChainCli(p, 'acceptance')).toBe('claude');
    expect(resolveRoleChainCli(p, 'unknown-role')).toBe('');
    expect(resolveRoleChainCli('/no/such/file.json', 'task-check')).toBe('');
  });

  test('resolveRoleWorkerCli prints the primary, or empty string', () => {
    const p = writeTmpConfig(VALID);
    expect(resolveRoleWorkerCli(p, 'task-check')).toBe('codex');
    expect(resolveRoleWorkerCli(p, 'unknown-role')).toBe('');
    expect(resolveRoleWorkerCli('/no/such/file.json', 'task-check')).toBe('');
  });
});

describe('reorderChainForPin (SOT-1555 implementation-not-required pin)', () => {
  test('moves the pinned worker to the front, preserving the rest as fallback', () => {
    expect(reorderChainForPin(['codex', 'claude', 'antigravity'], 'claude')).toEqual([
      'claude',
      'codex',
      'antigravity',
    ]);
  });

  test('is a no-op when the pinned worker is already primary', () => {
    expect(reorderChainForPin(['codex', 'claude'], 'codex')).toEqual(['codex', 'claude']);
  });

  test('returns the chain unchanged when the pin is not in the chain', () => {
    expect(reorderChainForPin(['codex', 'claude'], 'antigravity')).toEqual(['codex', 'claude']);
  });

  test.each([
    ['', 'empty'],
    [null, 'null'],
    [undefined, 'undefined'],
    ['bogus', 'invalid worker'],
  ])('returns the chain unchanged for a %s pin (%s)', (pin: string | null | undefined, _label: string) => {
    expect(reorderChainForPin(['codex', 'claude', 'antigravity'], pin)).toEqual([
      'codex',
      'claude',
      'antigravity',
    ]);
  });

  test('does not mutate the input chain', () => {
    const chain: ('codex' | 'claude' | 'antigravity')[] = ['codex', 'claude', 'antigravity'];
    const out = reorderChainForPin(chain, 'antigravity');
    expect(chain).toEqual(['codex', 'claude', 'antigravity']);
    expect(out).toEqual(['antigravity', 'codex', 'claude']);
  });
});
