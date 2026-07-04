import {
  parseWorkerRoleDirectives,
  mergeWorkerRoleOverrides,
} from '../lib/workerRoleDirective.js';
import type { WorkerRoleConfig } from '../lib/workerRoles.js';

const BASE: WorkerRoleConfig = {
  'task-check': ['codex', 'claude', 'antigravity'],
  decomposition: ['claude', 'codex', 'antigravity'],
  implementation: ['antigravity', 'codex', 'claude'],
  verification: ['codex', 'claude', 'antigravity'],
  acceptance: ['claude', 'codex', 'antigravity'],
  github: ['claude', 'codex', 'antigravity'],
  'linear-report': ['claude', 'codex', 'antigravity'],
};

describe('parseWorkerRoleDirectives', () => {
  test('parses a single-line directive with multiple roles', () => {
    const { overrides, warnings } = parseWorkerRoleDirectives(
      'Some description.\nworkers: implementation=codex, verification=claude\nmore text',
    );
    expect(overrides).toEqual({ implementation: ['codex'], verification: ['claude'] });
    expect(warnings).toEqual([]);
  });

  test('accepts `worker:` singular and is case-insensitive for keys/values', () => {
    const { overrides } = parseWorkerRoleDirectives('WORKER: Implementation=CODEX');
    expect(overrides).toEqual({ implementation: ['codex'] });
  });

  test('supports fallback chains via > | /', () => {
    const { overrides } = parseWorkerRoleDirectives(
      'workers: implementation=codex>claude, github=antigravity|codex, task-check=codex/claude',
    );
    expect(overrides.implementation).toEqual(['codex', 'claude']);
    expect(overrides.github).toEqual(['antigravity', 'codex']);
    expect(overrides['task-check']).toEqual(['codex', 'claude']);
  });

  test('maps the `agy` alias to antigravity and de-dupes a chain', () => {
    const { overrides } = parseWorkerRoleDirectives('workers: implementation=agy>agy>codex');
    expect(overrides.implementation).toEqual(['antigravity', 'codex']);
  });

  test('later directive (e.g. a newer comment) wins for the same role', () => {
    const text = ['workers: implementation=antigravity', 'workers: implementation=codex'].join('\n');
    expect(parseWorkerRoleDirectives(text).overrides).toEqual({ implementation: ['codex'] });
  });

  test('warns and skips unknown roles / workers, keeping valid ones', () => {
    const { overrides, warnings } = parseWorkerRoleDirectives(
      'workers: implementation=codex, deploy=codex, verification=gpt5',
    );
    expect(overrides).toEqual({ implementation: ['codex'] });
    expect(warnings.some((w) => w.includes('unknown role "deploy"'))).toBe(true);
    expect(warnings.some((w) => w.includes('unknown worker "gpt5"'))).toBe(true);
  });

  test('returns empty for no directive / empty input', () => {
    expect(parseWorkerRoleDirectives('just a normal description').overrides).toEqual({});
    expect(parseWorkerRoleDirectives('').overrides).toEqual({});
    expect(parseWorkerRoleDirectives(null).overrides).toEqual({});
  });
});

describe('mergeWorkerRoleOverrides', () => {
  test('replaces only the overridden roles, keeping base chains for the rest', () => {
    const merged = mergeWorkerRoleOverrides(BASE, {
      implementation: ['codex'],
      github: ['antigravity', 'claude'],
    });
    expect(merged.implementation).toEqual(['codex']);
    expect(merged.github).toEqual(['antigravity', 'claude']);
    // untouched roles keep the base chain
    expect(merged['task-check']).toEqual(['codex', 'claude', 'antigravity']);
    expect(merged.verification).toEqual(['codex', 'claude', 'antigravity']);
  });

  test('does not mutate the base config', () => {
    const baseCopy = JSON.parse(JSON.stringify(BASE));
    mergeWorkerRoleOverrides(BASE, { implementation: ['codex'] });
    expect(BASE).toEqual(baseCopy);
  });

  test('an empty override map yields a config equal to the base', () => {
    expect(mergeWorkerRoleOverrides(BASE, {})).toEqual(BASE);
  });
});
