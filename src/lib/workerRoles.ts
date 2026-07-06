// SOT-1459: per-role worker assignment resolver (priority chains).
//
// The harness splits work into roles (task-check / decomposition / implementation / verification /
// acceptance / github / linear-report). Which worker handles each role is configured in an editable
// file — `config/worker_roles.json` — NOT in `.env`. Each role maps to an ORDERED PRIORITY CHAIN of
// workers: index 0 is the primary (tried first) and the rest are the fallback order, tried in turn
// when a worker is non-responsive (exit 75) or hits its usage limit. A bare string value is accepted
// as a single-element chain for backward compatibility.
//
// The dispatcher (`scripts/ai/run_worker.sh <role>`) consults the same file (via the inline node
// one-liner using `resolveRoleChainCli` below) and invokes each worker's run script in order —
// `run_codex.sh` / `run_claude.sh` / `run_antigravity.sh` — handing off to the next worker on
// non-response. This per-role config is the single top-level worker selector; the former global env
// kill-switches (`ALL_CLAUDE_MODE`, `WORKER_MODE`) have been removed. Only the per-worker availability
// flags (`CODEX_DISABLED` / `ANTIGRAVITY_DISABLED` / `CLAUDE_DISABLED`) and the usage-limit cooldown
// are evaluated per worker, after chain selection.

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

/** Each role resolves to a non-empty ordered chain of workers (primary first, then fallbacks). */
export type WorkerRoleConfig = Record<WorkerRole, Worker[]>;

function isWorkerRole(value: string): value is WorkerRole {
  return (WORKER_ROLES as readonly string[]).includes(value);
}

function isWorker(value: unknown): value is Worker {
  return typeof value === 'string' && (WORKERS as readonly string[]).includes(value);
}

/**
 * Normalize a raw config value (string | string[]) into a validated, de-duplicated worker chain.
 * Throws a clear Error when the value is empty or contains a non-worker entry.
 */
function normalizeChain(role: string, value: unknown, configPath: string): Worker[] {
  const raw = Array.isArray(value) ? value : [value];
  if (raw.length === 0) {
    throw new Error(`worker_roles["${role}"] must be a non-empty worker chain (${configPath})`);
  }
  const chain: Worker[] = [];
  for (const entry of raw) {
    if (!isWorker(entry)) {
      throw new Error(
        `worker_roles["${role}"] contains invalid worker ${JSON.stringify(entry)} (${configPath}); valid workers: ${WORKERS.join(', ')}`,
      );
    }
    if (!chain.includes(entry)) chain.push(entry); // de-dupe while preserving order
  }
  return chain;
}

/**
 * Load and validate `config/worker_roles.json`, returning a complete role → worker-chain map.
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
    result[key] = normalizeChain(key, value, configPath);
  }

  const missing = WORKER_ROLES.filter((role) => !(role in result));
  if (missing.length > 0) {
    throw new Error(`worker_roles config is missing role(s): ${missing.join(', ')} (${configPath})`);
  }

  return result;
}

/**
 * Resolve the full ordered worker chain assigned to a role. Returns [] when the role is unknown or
 * the config cannot be read/parsed — callers (notably the shell dispatcher) treat [] as "no
 * override" and fall back to existing behavior, so a broken/absent config never blocks work.
 */
export function resolveRoleChain(
  role: string,
  configPath: string = DEFAULT_CONFIG_PATH,
): Worker[] {
  if (!isWorkerRole(role)) return [];
  let config: WorkerRoleConfig;
  try {
    config = loadWorkerRolesConfig(configPath);
  } catch {
    return [];
  }
  return config[role] ?? [];
}

/**
 * Resolve the PRIMARY worker for a role (chain index 0). Returns null when the role is unknown or
 * the config is unreadable. Kept for backward compatibility with single-worker callers.
 */
export function resolveRoleWorker(
  role: string,
  configPath: string = DEFAULT_CONFIG_PATH,
): Worker | null {
  const chain = resolveRoleChain(role, configPath);
  return chain[0] ?? null;
}

/**
 * SOT-1555: reorder a resolved worker chain so a PINNED worker is tried FIRST.
 *
 * When task-check classifies an issue as implementation-not-required (DOC / REVIEW / QUESTION /
 * SECURITY-scan / trivial), the pipeline pins every subsequent role to the SAME worker that handled
 * task-check, so the whole lifecycle is completed by one AI with no cross-worker handoff (the human
 * requirement in SOT-1555). This is a REORDER, not a replacement: the pinned worker is moved to the
 * front and the remaining chain is preserved as fallback, so if the pinned worker becomes
 * non-responsive the dispatcher still hands off to the others (fail-open — never a deadlock).
 *
 * Rules:
 * - `pinned` empty / not a valid worker / not present in `chain` → return `chain` unchanged.
 * - otherwise move `pinned` to index 0, keeping the relative order of the rest (de-duplicated).
 *
 * NOTE: `scripts/ai/run_worker.sh` applies the identical rule inline (it reads the pin from
 * `PIPELINE_PINNED_WORKER`); this function is the reference spec covered by unit tests.
 */
export function reorderChainForPin(chain: Worker[], pinned: string | null | undefined): Worker[] {
  if (!pinned || !isWorker(pinned) || !chain.includes(pinned)) return [...chain];
  return [pinned, ...chain.filter((w) => w !== pinned)];
}

/**
 * CLI entry used by the dispatcher: prints the ordered worker chain for a role, space-separated
 * (empty string when there is no override). `node -e "..." <configPath> <role>`.
 */
export function resolveRoleChainCli(configPath: string, role: string): string {
  return resolveRoleChain(role, configPath).join(' ');
}

/**
 * CLI entry retained for backward compatibility: prints the primary worker for a role (or empty
 * string when there is no override).
 */
export function resolveRoleWorkerCli(configPath: string, role: string): string {
  return resolveRoleWorker(role, configPath) ?? '';
}
