// SOT-1459: per-role worker assignment resolver.
//
// The harness splits work into roles (task-check / decomposition / implementation / verification /
// acceptance / github / linear-report). Which worker handles each role is configured in an editable
// file — `config/worker_roles.json` — NOT in `.env`. This module loads and validates that file and
// resolves a role → worker. `github` (branch/PR/merge) and `linear-report` (Linear state sync +
// progress reporting) are Claude-owned by default but may be reassigned like any other role.
//
// The run scripts (`scripts/ai/run_codex.sh`, `scripts/ai/run_antigravity.sh`) consult the same file
// (via an inline node one-liner using `resolveRoleWorkerCli` below) so that, e.g., verification can be
// routed to Claude while implementation stays on Antigravity. Global env kill-switches
// (`ALL_CLAUDE_MODE`, `WORKER_MODE`) still take precedence over this per-role config.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// repo root = src/lib/../.. (this file lives in src/lib/)
const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'worker_roles.json');

export const WORKER_ROLES = [
  'task-check',
  'decomposition',
  'implementation',
  'verification',
  'acceptance',
  'github',
  'linear-report',
] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

export const WORKERS = ['claude', 'codex', 'antigravity'] as const;
export type Worker = (typeof WORKERS)[number];

export type WorkerRoleConfig = Record<WorkerRole, Worker>;

function isWorkerRole(value: string): value is WorkerRole {
  return (WORKER_ROLES as readonly string[]).includes(value);
}

function isWorker(value: unknown): value is Worker {
  return typeof value === 'string' && (WORKERS as readonly string[]).includes(value);
}

/**
 * Load and validate `config/worker_roles.json`, returning a complete role → worker map.
 * Keys starting with `__` (e.g. `__doc__`) are ignored. Throws a clear Error when the file is
 * missing, is not valid JSON, contains an unknown role/worker, or omits a required role.
 */
export function loadWorkerRolesConfig(configPath: string = DEFAULT_CONFIG_PATH): WorkerRoleConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err: any) {
    throw new Error(`worker_roles config not found at ${configPath}: ${err.message}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`worker_roles config is not valid JSON (${configPath}): ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`worker_roles config must be an object (${configPath})`);
  }

  const result = {} as WorkerRoleConfig;
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith('__')) continue; // documentation keys
    if (!isWorkerRole(key)) {
      throw new Error(
        `worker_roles config has unknown role "${key}" (${configPath}); valid roles: ${WORKER_ROLES.join(', ')}`,
      );
    }
    if (!isWorker(value)) {
      throw new Error(
        `worker_roles["${key}"] must be one of ${WORKERS.join(', ')} (${configPath}), got ${JSON.stringify(value)}`,
      );
    }
    result[key] = value;
  }

  const missing = WORKER_ROLES.filter((role) => !(role in result));
  if (missing.length > 0) {
    throw new Error(`worker_roles config is missing role(s): ${missing.join(', ')} (${configPath})`);
  }

  return result;
}

/**
 * Resolve the worker assigned to a role. Returns null when the role is unknown or the config cannot
 * be read/parsed — callers (notably the shell gate) treat null as "no per-role override" and fall
 * back to existing behavior, so a broken/absent config never blocks a worker.
 */
export function resolveRoleWorker(
  role: string,
  configPath: string = DEFAULT_CONFIG_PATH,
): Worker | null {
  if (!isWorkerRole(role)) return null;
  let config: WorkerRoleConfig;
  try {
    config = loadWorkerRolesConfig(configPath);
  } catch {
    return null;
  }
  return config[role] ?? null;
}

/**
 * CLI entry used by the run scripts: `node -e "..." <configPath> <role>` prints the assigned worker
 * (or empty string when there is no override). Kept side-effect-light so it can be required inline.
 */
export function resolveRoleWorkerCli(configPath: string, role: string): string {
  return resolveRoleWorker(role, configPath) ?? '';
}
