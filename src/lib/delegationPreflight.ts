'use strict';

// SOT-1574: delegation / cost preflight summary.
//
// `run_auto.sh` runs a sequence of roles (task-check → implementation → verification → acceptance →
// github → linear-report), each dispatched to a worker chosen by `config/worker_roles.json` (possibly
// overridden per-issue via `WORKER_ROLES_FILE`). Before the role loop starts it is useful to print, in
// ONE human-readable block, (a) which worker will handle each role (the delegation map) and (b) a
// QUALITATIVE cost/usage estimate — never a dollar figure, since real spend is not obtainable. This
// module builds that block as a PURE function (no fs / no env), so the shell/CLI reads the state and
// this stays trivially unit-testable.

import type { WorkerRole, Worker, WorkerRoleConfig } from './workerRoles.js';

/** Auth-unhealthy marker snapshot (subset of workerHealth.AuthUnhealthyStatus). */
export interface PreflightAuthStatus {
  active: boolean;
  remainingSeconds?: number | null;
}

/** Cooldown snapshot for a single worker (subset of workerCooldown.WorkerCooldown). */
export interface PreflightCooldown {
  worker: string;
  active: boolean;
  remainingHuman?: string | null;
}

export interface DelegationPreflightInput {
  /** Target issue id (for the block header). */
  issue?: string;
  /** Ordered pipeline roles to display (the real run_auto.sh sequence). */
  roles: WorkerRole[];
  /** Resolved role → worker chain (already merged with any per-issue override). */
  config: WorkerRoleConfig;
  /** Base config (pre-override) — a role whose chain differs is marked `(override)`. Optional. */
  baseConfig?: WorkerRoleConfig | null;
  /** Per-role model pins (`__models__` section of the resolved file). Optional. */
  models?: Partial<Record<WorkerRole, Record<string, string>>> | null;
  /** Worker cooldown snapshots (antigravity / codex / runner). Optional. */
  cooldowns?: PreflightCooldown[] | null;
  /** Auth-unhealthy markers keyed by worker. Optional. */
  authUnhealthy?: Partial<Record<Worker, PreflightAuthStatus>> | null;
  /** PIPELINE_MAX_DEBUG_CYCLES (loop-back bound). */
  maxDebugCycles: number;
}

function primaryOf(chain: Worker[] | undefined): Worker | '?' {
  return chain && chain.length > 0 ? chain[0] : '?';
}

function chainsDiffer(a?: Worker[], b?: Worker[]): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return true;
  return a.some((w, i) => w !== b[i]);
}

/**
 * Build the one-block delegation/cost preflight summary as an array of lines (no log prefix — the
 * caller prefixes each line, e.g. with `[pipeline]`). Pure: depends only on its input.
 */
export function buildDelegationPreflightLines(input: DelegationPreflightInput): string[] {
  const { roles, config, baseConfig, models, cooldowns, authUnhealthy, maxDebugCycles } = input;
  const lines: string[] = [];

  lines.push(`── Delegation / Cost Preflight${input.issue ? ` (${input.issue})` : ''} ──`);

  // (1) Delegation map: role → primary worker [full chain] (override) model=…
  lines.push('Delegation map (role → primary [chain]):');
  let claudePrimaryCount = 0;
  for (const role of roles) {
    const chain = config[role];
    const primary = primaryOf(chain);
    if (primary === 'claude') claudePrimaryCount += 1;
    const chainStr = chain && chain.length > 0 ? chain.join('>') : '<none>';
    const overridden = baseConfig ? chainsDiffer(chain, baseConfig[role]) : false;
    const pin = models && models[role] && primary !== '?' ? (models[role] as Record<string, string>)[primary] : undefined;
    const tags = [overridden ? '(override)' : '', pin ? `model=${pin}` : ''].filter(Boolean).join(' ');
    lines.push(`  ${role.padEnd(15)} ${String(primary).padEnd(11)} [${chainStr}]${tags ? '  ' + tags : ''}`);
  }

  // (2) Qualitative cost / usage — NO dollar figures (real spend is not obtainable).
  lines.push('Cost / usage (qualitative — no dollar figures):');
  const total = roles.length;
  lines.push(
    `  Claude primary roles: ${claudePrimaryCount}/${total}` +
      (claudePrimaryCount > 0
        ? ` → account-global Claude usage limit consumed ~${claudePrimaryCount}× faster (limit is shared)`
        : ' → no Claude-primary roles'),
  );

  // Worker cooldown / auth-unhealthy state (only surface what is ACTIVE; else "all clear").
  const impaired: string[] = [];
  for (const c of cooldowns || []) {
    if (c && c.active) impaired.push(`${c.worker} cooldown${c.remainingHuman ? ` (${c.remainingHuman} left)` : ''}`);
  }
  for (const [worker, st] of Object.entries(authUnhealthy || {})) {
    if (st && st.active) {
      const rem = typeof st.remainingSeconds === 'number' && st.remainingSeconds > 0 ? ` (${st.remainingSeconds}s left)` : '';
      impaired.push(`${worker} auth-unhealthy${rem}`);
    }
  }
  lines.push(`  Worker availability: ${impaired.length > 0 ? impaired.join('; ') : 'all clear (no active cooldown / auth marker)'}`);

  // (3) Loop bound: how many worker legs the pipeline can run at most.
  // Base = one leg per role. Each debug loop-back re-runs implementation + verification + acceptance
  // (~3 legs). Upper bound is an approximation for cost intuition, not a hard guarantee.
  const maxLegs = total + Math.max(0, maxDebugCycles) * 3;
  lines.push(
    `  Loop bound: PIPELINE_MAX_DEBUG_CYCLES=${maxDebugCycles} → up to ~${maxLegs} worker legs ` +
      `(${total} roles + ${Math.max(0, maxDebugCycles)}×~3 debug loop-backs)`,
  );

  lines.push('────────────────────────────────────────');
  return lines;
}

/** Convenience: the block as a single newline-joined string. */
export function buildDelegationPreflight(input: DelegationPreflightInput): string {
  return buildDelegationPreflightLines(input).join('\n');
}
