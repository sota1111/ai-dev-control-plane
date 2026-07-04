// SOT-1459: per-issue worker override directives from Linear.
//
// A human can steer which worker handles a role for ONE issue by writing a directive line in the
// Linear issue description or a comment:
//
//   workers: implementation=codex, verification=claude
//
// Each `role=chain` pair overrides that role's worker chain for this issue only (roles not mentioned
// keep the config/worker_roles.json default). A chain may list fallbacks with `>` (or `|` / `/`):
//
//   workers: implementation=codex>claude, github=antigravity
//
// This module is pure (no I/O): it parses directive text and merges overrides onto a base config. The
// runner-cli `resolve-worker-roles` subcommand fetches the issue text, calls these, and writes a
// per-issue merged config that run_auto.sh points WORKER_ROLES_FILE at for the pipeline run.

import {
  WORKER_ROLES,
  type WorkerRole,
  type Worker,
  type WorkerRoleConfig,
} from './workerRoles.js';

// Accepted worker tokens (case-insensitive), including the `agy` alias used by the Antigravity CLI.
const WORKER_ALIASES: Record<string, Worker> = {
  claude: 'claude',
  codex: 'codex',
  antigravity: 'antigravity',
  agy: 'antigravity',
};

export interface DirectiveParseResult {
  /** Role → overridden worker chain. Later directives (e.g. a newer comment) win. */
  overrides: Partial<Record<WorkerRole, Worker[]>>;
  /** Human-readable notes about ignored/invalid tokens (never throws). */
  warnings: string[];
}

function isWorkerRole(value: string): value is WorkerRole {
  return (WORKER_ROLES as readonly string[]).includes(value);
}

/**
 * Parse all `workers:`/`worker:` directive lines from a text blob (description + comments concatenated,
 * oldest first so the newest occurrence wins). Never throws; invalid roles/workers are skipped with a
 * warning. Returns the per-role chain overrides.
 */
export function parseWorkerRoleDirectives(text: string | null | undefined): DirectiveParseResult {
  const overrides: Partial<Record<WorkerRole, Worker[]>> = {};
  const warnings: string[] = [];
  if (!text) return { overrides, warnings };

  const lineRe = /^\s*workers?\s*:\s*(.+?)\s*$/i;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(lineRe);
    if (!m) continue;
    // Split the directive body into `role=chain` pairs by comma or semicolon.
    for (const pairRaw of m[1].split(/[,;]/)) {
      const pair = pairRaw.trim();
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq < 0) {
        warnings.push(`ignored directive token (missing '='): "${pair}"`);
        continue;
      }
      const role = pair.slice(0, eq).trim().toLowerCase();
      if (!isWorkerRole(role)) {
        warnings.push(`unknown role "${role}" (valid: ${WORKER_ROLES.join(', ')})`);
        continue;
      }
      const chain: Worker[] = [];
      for (const tokenRaw of pair.slice(eq + 1).split(/[>|/]/)) {
        const token = tokenRaw.trim().toLowerCase();
        if (!token) continue;
        const worker = WORKER_ALIASES[token];
        if (!worker) {
          warnings.push(`unknown worker "${token}" for role "${role}"`);
          continue;
        }
        if (!chain.includes(worker)) chain.push(worker); // de-dupe, preserve order
      }
      if (chain.length === 0) {
        warnings.push(`no valid worker specified for role "${role}"`);
        continue;
      }
      overrides[role] = chain; // later occurrence overrides earlier
    }
  }
  return { overrides, warnings };
}

/**
 * Apply per-role chain overrides onto a base config, returning a new complete config. Roles without an
 * override keep the base chain. The base already covers every role, so the result stays valid.
 */
export function mergeWorkerRoleOverrides(
  base: WorkerRoleConfig,
  overrides: Partial<Record<WorkerRole, Worker[]>>,
): WorkerRoleConfig {
  const merged = {} as WorkerRoleConfig;
  for (const role of WORKER_ROLES) {
    const override = overrides[role];
    merged[role] = override && override.length > 0 ? [...override] : [...base[role]];
  }
  return merged;
}
