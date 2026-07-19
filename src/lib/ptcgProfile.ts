import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoForProject, type ProjectRepo } from './projectRepo.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'ptcg_profiles.json');
const SAFE_REPO = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const SAFE_BRANCH = /^[a-zA-Z0-9._/-]+$/;
const PTCG_INTENT = /(?:PTCG|ポケモンカード|ポケカ|松竹梅|(?:^|\s)(?:matsu|take|ume|zero)(?:\s|$))/iu;

export interface PtcgDefaults {
  matches: number;
  seed: number;
  deckMode: string;
}
export interface PtcgAgentProfile {
  id: string;
  aliases: string[];
  repo: string;
  localPath: string;
  branch: string;
  deck: string;
  entrypoint?: string;
  defaults: PtcgDefaults;
}
export interface PtcgHarnessProfile {
  repo: string;
  localPath: string;
  branch: string;
  entrypoint: string;
  compatibleSchemaVersions: string[];
  defaults: PtcgDefaults;
}
export interface PtcgProfileConfig {
  enabled: boolean;
  schemaVersion: 'ptcg-profile/v1';
  harness: PtcgHarnessProfile;
  profiles: PtcgAgentProfile[];
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${label} must be a non-empty string`);
}

function safeRelative(value: unknown, label: string): asserts value is string {
  nonEmpty(value, label);
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
    throw new Error(`${label} must be a safe repository-relative path`);
  }
}

export function validatePtcgProfileConfig(value: unknown): PtcgProfileConfig {
  if (!value || typeof value !== 'object') throw new Error('PTCG profile config must be an object');
  const c = value as any;
  if (typeof c.enabled !== 'boolean') throw new Error('enabled must be boolean');
  if (c.schemaVersion !== 'ptcg-profile/v1')
    throw new Error('unsupported PTCG profile schemaVersion');
  if (!c.harness || typeof c.harness !== 'object') throw new Error('harness must be an object');
  for (const key of ['repo', 'localPath', 'branch']) nonEmpty(c.harness[key], `harness.${key}`);
  if (!SAFE_REPO.test(c.harness.repo)) throw new Error('harness.repo must be owner/repository');
  if (!path.isAbsolute(c.harness.localPath)) throw new Error('harness.localPath must be absolute');
  if (!SAFE_BRANCH.test(c.harness.branch) || c.harness.branch.includes('..'))
    throw new Error('harness.branch is invalid');
  safeRelative(c.harness.entrypoint, 'harness.entrypoint');
  if (
    !Array.isArray(c.harness.compatibleSchemaVersions) ||
    c.harness.compatibleSchemaVersions.length === 0 ||
    c.harness.compatibleSchemaVersions.some((v: unknown) => typeof v !== 'string')
  ) {
    throw new Error('harness.compatibleSchemaVersions must be a non-empty string array');
  }
  if (
    !c.harness.defaults ||
    !Number.isInteger(c.harness.defaults.matches) ||
    c.harness.defaults.matches <= 0 ||
    !Number.isInteger(c.harness.defaults.seed) ||
    typeof c.harness.defaults.deckMode !== 'string'
  ) {
    throw new Error('harness.defaults is invalid');
  }
  if (!Array.isArray(c.profiles) || c.profiles.length !== 4)
    throw new Error('profiles must contain exactly 松・竹・梅・zero');
  const ids = new Set<string>();
  for (const [i, p] of c.profiles.entries()) {
    if (!p || typeof p !== 'object') throw new Error(`profiles[${i}] must be an object`);
    nonEmpty(p.id, `profiles[${i}].id`);
    if (!['matsu', 'take', 'ume', 'zero'].includes(p.id) || ids.has(p.id))
      throw new Error('profiles must uniquely define matsu, take, ume, and zero');
    ids.add(p.id);
    if (
      !Array.isArray(p.aliases) ||
      p.aliases.length === 0 ||
      p.aliases.some((a: unknown) => typeof a !== 'string' || !a.trim())
    )
      throw new Error(`profiles[${i}].aliases is invalid`);
    nonEmpty(p.repo, `profiles[${i}].repo`);
    nonEmpty(p.localPath, `profiles[${i}].localPath`);
    nonEmpty(p.branch, `profiles[${i}].branch`);
    if (!SAFE_REPO.test(p.repo)) throw new Error(`profiles[${i}].repo must be owner/repository`);
    if (!path.isAbsolute(p.localPath)) throw new Error(`profiles[${i}].localPath must be absolute`);
    if (!SAFE_BRANCH.test(p.branch) || p.branch.includes('..'))
      throw new Error(`profiles[${i}].branch is invalid`);
    safeRelative(p.deck, `profiles[${i}].deck`);
    if (p.entrypoint !== undefined) nonEmpty(p.entrypoint, `profiles[${i}].entrypoint`);
    if (
      !p.defaults ||
      !Number.isInteger(p.defaults.matches) ||
      p.defaults.matches <= 0 ||
      !Number.isInteger(p.defaults.seed) ||
      typeof p.defaults.deckMode !== 'string'
    )
      throw new Error(`profiles[${i}].defaults is invalid`);
  }
  return c as PtcgProfileConfig;
}

export function loadPtcgProfileConfig(configPath = DEFAULT_CONFIG): PtcgProfileConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error: any) {
    throw new Error(`PTCG profile config not found: ${error.message}`);
  }
  try {
    return validatePtcgProfileConfig(JSON.parse(raw));
  } catch (error: any) {
    if (error instanceof SyntaxError)
      throw new Error(`PTCG profile config is not valid JSON: ${error.message}`);
    throw error;
  }
}

export type RepositoryResolution =
  | { source: 'repository' | 'project'; target: ProjectRepo; ptcg: null }
  | { source: 'ptcg-profile'; target: ProjectRepo; ptcg: PtcgProfileConfig };

export function resolveRepository(input: {
  repository?: ProjectRepo | null;
  project?: string | null;
  intent?: string | null;
  projectConfig?: ProjectRepo[];
  ptcgConfig?: PtcgProfileConfig;
  profileEnabled?: boolean;
}): RepositoryResolution | null {
  if (input.repository) return { source: 'repository', target: input.repository, ptcg: null };
  if (input.project?.trim()) {
    const target = resolveRepoForProject(input.project, input.projectConfig);
    return target ? { source: 'project', target, ptcg: null } : null;
  }
  const config = input.ptcgConfig ?? loadPtcgProfileConfig();
  const enabledByEnv = !/^(?:0|false|no|off)$/i.test(process.env.PTCG_PROFILE_ENABLED ?? '1');
  if (
    input.profileEnabled === false ||
    !enabledByEnv ||
    !config.enabled ||
    !PTCG_INTENT.test(input.intent ?? '')
  )
    return null;
  return {
    source: 'ptcg-profile',
    target: {
      project: 'ptcg-battle-lab',
      repo: config.harness.repo,
      localPath: config.harness.localPath,
    },
    ptcg: config,
  };
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface PtcgPreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

/** Purely bounded filesystem checks: no network and no child processes. */
export function preflightPtcg(config: PtcgProfileConfig): PtcgPreflightResult {
  const checks: PreflightCheck[] = [];
  const checkFile = (name: string, absolutePath: string, missing: string) =>
    checks.push({
      name,
      ok: fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile(),
      detail: fs.existsSync(absolutePath) ? 'present' : missing,
    });
  const harnessPackage = path.join(config.harness.localPath, 'package.json');
  checks.push({
    name: 'harness repository',
    ok: fs.existsSync(path.join(config.harness.localPath, '.git')),
    detail: fs.existsSync(path.join(config.harness.localPath, '.git'))
      ? 'present'
      : 'missing repository',
  });
  checkFile(
    'harness entrypoint',
    path.join(config.harness.localPath, config.harness.entrypoint),
    'missing harness entrypoint'
  );
  checkFile('Node environment', harnessPackage, 'missing package.json');
  checks.push({
    name: 'harness compatibility',
    ok: config.harness.compatibleSchemaVersions.includes('ptcg-battle-lab/v2'),
    detail: config.harness.compatibleSchemaVersions.includes('ptcg-battle-lab/v2')
      ? 'compatible'
      : 'ptcg-battle-lab/v2 is not supported',
  });
  for (const profile of config.profiles) {
    const git = path.join(profile.localPath, '.git');
    checks.push({
      name: `${profile.id} repository`,
      ok: fs.existsSync(git),
      detail: fs.existsSync(git) ? 'present' : 'missing repository',
    });
    checkFile(`${profile.id} deck`, path.join(profile.localPath, profile.deck), 'missing deck');
    const python = [
      '.venv/bin/python',
      'venv/bin/python',
      'pyproject.toml',
      'requirements.txt',
    ].some((p) => fs.existsSync(path.join(profile.localPath, p)));
    checks.push({
      name: `${profile.id} Python environment`,
      ok: python,
      detail: python ? 'present' : 'missing Python environment metadata',
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}
