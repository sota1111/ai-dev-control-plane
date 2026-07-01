import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WORKER_ROLES,
  WORKERS,
  loadWorkerRolesConfig,
  resolveRoleWorker,
  resolveRoleWorkerCli,
} from '../lib/workerRoles.js';

function writeTmpConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-roles-'));
  const p = path.join(dir, 'worker_roles.json');
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

const VALID = JSON.stringify({
  __doc__: 'ignored documentation key',
  'task-check': 'codex',
  decomposition: 'claude',
  implementation: 'antigravity',
  verification: 'codex',
  acceptance: 'claude',
});

describe('loadWorkerRolesConfig', () => {
  test('loads a valid config and ignores __ keys', () => {
    const p = writeTmpConfig(VALID);
    const cfg = loadWorkerRolesConfig(p);
    expect(cfg).toEqual({
      'task-check': 'codex',
      decomposition: 'claude',
      implementation: 'antigravity',
      verification: 'codex',
      acceptance: 'claude',
    });
  });

  test('the committed config/worker_roles.json is valid and covers every role', () => {
    const repoConfig = path.join(process.cwd(), 'config', 'worker_roles.json');
    const cfg = loadWorkerRolesConfig(repoConfig);
    for (const role of WORKER_ROLES) {
      expect(WORKERS).toContain(cfg[role]);
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

  test('throws on an invalid worker value', () => {
    const p = writeTmpConfig(
      JSON.stringify({
        'task-check': 'gemini',
        decomposition: 'claude',
        implementation: 'antigravity',
        verification: 'codex',
        acceptance: 'claude',
      }),
    );
    expect(() => loadWorkerRolesConfig(p)).toThrow(/must be one of/);
  });

  test('throws when a required role is missing', () => {
    const p = writeTmpConfig(JSON.stringify({ 'task-check': 'codex' }));
    expect(() => loadWorkerRolesConfig(p)).toThrow(/missing role/);
  });
});

describe('resolveRoleWorker', () => {
  test('returns the assigned worker for a known role', () => {
    const p = writeTmpConfig(VALID);
    expect(resolveRoleWorker('verification', p)).toBe('codex');
    expect(resolveRoleWorker('implementation', p)).toBe('antigravity');
    expect(resolveRoleWorker('acceptance', p)).toBe('claude');
  });

  test('returns null for an unknown role (no override)', () => {
    const p = writeTmpConfig(VALID);
    expect(resolveRoleWorker('deploy', p)).toBeNull();
  });

  test('returns null (fail-open) when the config is unreadable', () => {
    expect(resolveRoleWorker('verification', '/no/such/worker_roles.json')).toBeNull();
  });

  test('honors a rerouted role (verification -> claude)', () => {
    const p = writeTmpConfig(
      JSON.stringify({
        'task-check': 'codex',
        decomposition: 'claude',
        implementation: 'antigravity',
        verification: 'claude',
        acceptance: 'claude',
      }),
    );
    expect(resolveRoleWorker('verification', p)).toBe('claude');
  });
});

describe('resolveRoleWorkerCli', () => {
  test('prints the worker, or empty string when there is no override', () => {
    const p = writeTmpConfig(VALID);
    expect(resolveRoleWorkerCli(p, 'task-check')).toBe('codex');
    expect(resolveRoleWorkerCli(p, 'unknown-role')).toBe('');
    expect(resolveRoleWorkerCli('/no/such/file.json', 'task-check')).toBe('');
  });
});
