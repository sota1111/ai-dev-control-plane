import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  loadPtcgProfileConfig,
  preflightPtcg,
  resolveRepository,
  validatePtcgProfileConfig,
  type PtcgProfileConfig,
} from '../lib/ptcgProfile.js';

const project = {
  project: 'explicit-project',
  repo: 'owner/explicit',
  localPath: '/workspaces/explicit',
};

function fixture(root: string): PtcgProfileConfig {
  const makeRepo = (name: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.venv', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.venv', 'bin', 'python'), '');
    fs.writeFileSync(path.join(dir, 'deck.csv'), 'card,count\n');
    return dir;
  };
  const harness = makeRepo('harness');
  fs.mkdirSync(path.join(harness, 'src'), { recursive: true });
  fs.writeFileSync(path.join(harness, 'src', 'ptcg-battle-lab-cli.ts'), '');
  fs.writeFileSync(path.join(harness, 'package.json'), '{}');
  return {
    enabled: true,
    schemaVersion: 'ptcg-profile/v1',
    harness: {
      repo: 'owner/harness',
      localPath: harness,
      branch: 'main',
      entrypoint: 'src/ptcg-battle-lab-cli.ts',
      compatibleSchemaVersions: ['ptcg-battle-lab/v2'],
      defaults: { matches: 40, seed: 7, deckMode: 'own' },
    },
    profiles: ['matsu', 'take', 'ume'].map((id) => ({
      id,
      aliases: [id],
      repo: `owner/${id}`,
      localPath: makeRepo(id),
      branch: 'main',
      deck: 'deck.csv',
      defaults: { matches: 40, seed: 7, deckMode: 'own' },
    })),
  };
}

describe('PTCG profile schema and resolution', () => {
  test('loads the canonical 松・竹・梅 profile', () => {
    const config = loadPtcgProfileConfig();
    expect(config.profiles.map((p) => p.id)).toEqual(['matsu', 'take', 'ume']);
    expect(config.harness.repo).toBe('sota1111/ai-dev-control-plane');
  });

  test('repository-less PTCG intent uniquely resolves to the canonical harness', () => {
    const config = loadPtcgProfileConfig();
    const result = resolveRepository({
      intent: '松竹梅でポケカの総当たりをして',
      ptcgConfig: config,
    });
    expect(result?.source).toBe('ptcg-profile');
    expect(result?.target.repo).toBe(config.harness.repo);
    expect(result?.ptcg?.profiles).toHaveLength(3);
  });

  test('explicit repository and Project always take precedence', () => {
    const config = loadPtcgProfileConfig();
    expect(
      resolveRepository({
        repository: project,
        project: 'ignored',
        intent: 'PTCG',
        ptcgConfig: config,
      })?.source
    ).toBe('repository');
    expect(
      resolveRepository({
        project: 'explicit-project',
        intent: 'PTCG',
        projectConfig: [project],
        ptcgConfig: config,
      })?.source
    ).toBe('project');
    expect(
      resolveRepository({
        project: 'unknown-explicit-project',
        intent: 'PTCG',
        projectConfig: [project],
        ptcgConfig: config,
      })
    ).toBeNull();
  });

  test('disabled profile and non-PTCG intent preserve normal unresolved behavior', () => {
    const config = loadPtcgProfileConfig();
    expect(
      resolveRepository({ intent: 'PTCG battle', ptcgConfig: config, profileEnabled: false })
    ).toBeNull();
    expect(resolveRepository({ intent: 'booking monitor bug', ptcgConfig: config })).toBeNull();
  });

  test('environment flag disables the fallback', () => {
    const previous = process.env.PTCG_PROFILE_ENABLED;
    process.env.PTCG_PROFILE_ENABLED = 'off';
    try {
      expect(
        resolveRepository({ intent: 'PTCG battle', ptcgConfig: loadPtcgProfileConfig() })
      ).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.PTCG_PROFILE_ENABLED;
      else process.env.PTCG_PROFILE_ENABLED = previous;
    }
  });

  test('rejects traversal and malformed configuration', () => {
    const config = loadPtcgProfileConfig();
    expect(() =>
      validatePtcgProfileConfig({
        ...config,
        profiles: config.profiles.map((p, i) => (i ? p : { ...p, deck: '../secret' })),
      })
    ).toThrow('safe repository-relative');
    expect(() => validatePtcgProfileConfig({ ...config, schemaVersion: 'unknown' })).toThrow(
      'unsupported'
    );
  });
});

describe('bounded preflight', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-profile-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('passes against fake compatible repositories without exposing host paths', () => {
    const result = preflightPtcg(fixture(root));
    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(13);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  test('clearly diagnoses missing repository, Python, deck, and compatibility', () => {
    const config = fixture(root);
    fs.rmSync(path.join(config.profiles[0].localPath, '.git'), { recursive: true });
    fs.rmSync(path.join(config.profiles[1].localPath, '.venv'), { recursive: true });
    fs.rmSync(path.join(config.profiles[2].localPath, 'deck.csv'));
    config.harness.compatibleSchemaVersions = ['ptcg-battle-lab/v1'];
    const result = preflightPtcg(config);
    expect(result.ok).toBe(false);
    expect(result.checks.filter((c) => !c.ok).map((c) => c.detail)).toEqual(
      expect.arrayContaining([
        'missing repository',
        'missing Python environment metadata',
        'missing deck',
        'ptcg-battle-lab/v2 is not supported',
      ])
    );
  });

  test('CLI returns success for a fake repository integration fixture', () => {
    const config = fixture(root);
    const configPath = path.join(root, 'profile.json');
    fs.writeFileSync(configPath, JSON.stringify(config));
    const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const output = execFileSync(
      tsx,
      ['src/ptcg-profile-cli.ts', 'preflight', '--config', configPath],
      { cwd: process.cwd(), encoding: 'utf8' }
    );
    expect(output).toContain('PASS harness compatibility');
    expect(output).not.toContain(root);
    const bad = spawnSync(
      tsx,
      ['src/ptcg-profile-cli.ts', 'preflight', '--config', path.join(root, 'missing.json')],
      { cwd: process.cwd(), encoding: 'utf8' }
    );
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('config error');
  });
});
