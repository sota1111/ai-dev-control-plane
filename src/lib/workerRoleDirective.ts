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
// SOT-1583: a worker token may also carry a MODEL, as `worker:model`, so the human can pin not just the
// CLI but the specific model a role runs on. Each element of a fallback chain can carry its own model:
//
//   workers: implementation=codex:gpt-5.5, verification=claude:sonnet>codex:gpt-5.4-mini
//
// The model string is everything after the FIRST colon (so ids with dots/spaces/parens like
// "Gemini 3.5 Flash (High)" or "claude-sonnet-5" pass through verbatim). A missing/empty model just
// means "use the worker's default model" (fully backward compatible with the model-less syntax). The
// parsed models are returned separately (role → worker → model) so callers can keep treating the worker
// chain exactly as before; the dispatcher passes the resolved model to the selected worker's run script
// via its model env var (CODEX_MODEL / AGY_MODEL / CLAUDE_MODEL).
//
// SOT-1591: the same directive line can also flip SOLO MODE for one issue (one AI runs the whole
// lifecycle in a single dispatch). Use a `solo=` token:
//
//   workers: solo=codex           → this issue runs solo on codex (overrides the base __solo__)
//   workers: solo=claude:sonnet   → solo on claude with a model pin
//   workers: solo=off             → this issue runs the NORMAL per-role pipeline, even if base __solo__ is set
//
// `solo=off` (also none / false / 0) disables solo for the issue; `solo=<worker>[:model]` forces it.
// When no solo token is present the base config's __solo__ is inherited. A solo token combines with role
// overrides on the same line (e.g. `workers: solo=off, implementation=codex`).
//
// A Linear issue may also control whether a failed worker is handed off to the next worker:
//
//   workers: handoff=on     → allow the normal fallback chain (default)
//   workers: handoff=off    → try only the first worker for every role
//
// SOT-1753: a `discussion=` token names the PARTICIPANTS of the multi-round discussion mode
// (scripts/ai/run_discussion.sh). Unlike a role chain (`>` = fallback order, one worker acts), the
// participants are joined with `+` because they ALL take part, each speaking every round:
//
//   workers: discussion=codex:sol+claude:fable
//
// Each participant is a `worker[:model]` token (same model syntax as role chains — everything after
// the first colon). Duplicated workers with different models are allowed (e.g. two codex participants
// debating on different models). Newest occurrence wins.
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

/** SOT-1583: per-role model pins, keyed by the worker the model applies to. */
export type RoleModelMap = Partial<Record<WorkerRole, Partial<Record<Worker, string>>>>;
export type ReasoningRole = WorkerRole | 'solo';
export type RoleReasoningMap = Partial<Record<ReasoningRole, string>>;

/** Parse Linear `reasoning: role=level` lines. Newest value wins per role. */
export function parseReasoningDirectives(text: string | null | undefined): {
  reasoning: RoleReasoningMap;
  warnings: string[];
} {
  const reasoning: RoleReasoningMap = {};
  const warnings: string[] = [];
  if (!text) return { reasoning, warnings };
  const allowed = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*reasoning\s*:\s*(.+?)\s*$/i);
    if (!match) continue;
    for (const raw of match[1].split(/[,;]/)) {
      const [roleRaw, levelRaw, ...extra] = raw.split('=');
      const role = (roleRaw || '').trim().toLowerCase();
      const level = (levelRaw || '').trim().toLowerCase();
      if (extra.length || (role !== 'solo' && !isWorkerRole(role))) {
        warnings.push(`invalid reasoning role "${role}"`);
      } else if (!allowed.has(level)) {
        warnings.push(`invalid reasoning level "${level}" for role "${role}"`);
      } else {
        reasoning[role as ReasoningRole] = level;
      }
    }
  }
  return { reasoning, warnings };
}

/**
 * SOT-1591: per-issue SOLO override parsed from a `solo=` directive token.
 * - `{ disabled: true }`  ← `solo=off` (also `none` / `false` / `0`): force NORMAL per-role mode for
 *   this issue, even when the base config sets `__solo__`.
 * - `{ disabled: false, worker, model }` ← `solo=<worker>[:model]`: force SOLO mode with that worker
 *   (and optional model) for this issue, overriding the base `__solo__`.
 */
export type SoloDirective =
  | { disabled: true }
  | { disabled: false; worker: Worker; model: string | null };

/** SOT-1753: one participant of the discussion mode, parsed from a `worker[:model]` token. */
export interface DiscussionParticipant {
  worker: Worker;
  model: string | null;
}

export interface DirectiveParseResult {
  /** Role → overridden worker chain. Later directives (e.g. a newer comment) win. */
  overrides: Partial<Record<WorkerRole, Worker[]>>;
  /**
   * SOT-1583: Role → (worker → model) parsed from `worker:model` tokens. Only workers that were given
   * an explicit non-empty model appear here; a role/worker absent from this map uses its default model.
   */
  models: RoleModelMap;
  /** SOT-1591: per-issue solo override from a `solo=` token (undefined when not specified). */
  solo?: SoloDirective;
  /** Per-issue cross-worker handoff policy (undefined means inherit the default: allowed). */
  handoff?: boolean;
  /**
   * SOT-1753: discussion-mode participants from a `discussion=w1[:m1]+w2[:m2]` token (undefined when
   * not specified). Order is preserved — participants speak in this order each round.
   */
  discussion?: DiscussionParticipant[];
  /** Human-readable notes about ignored/invalid tokens (never throws). */
  warnings: string[];
}

/** Parse `graph: <name>` lines. Description/comments must be concatenated oldest first. */
export function parseGraphDirective(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  let selected: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*graph\s*:\s*([a-zA-Z0-9][a-zA-Z0-9_-]*)\s*$/i);
    if (match) selected = match[1];
  }
  return selected;
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
  const models: RoleModelMap = {};
  const warnings: string[] = [];
  let solo: SoloDirective | undefined;
  let handoff: boolean | undefined;
  let discussion: DiscussionParticipant[] | undefined;
  if (!text) return { overrides, models, warnings };

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
      if (role === 'handoff') {
        const value = pair.slice(eq + 1).trim().toLowerCase();
        if (['on', 'true', 'yes', '1', 'allow', 'allowed'].includes(value)) {
          handoff = true;
        } else if (['off', 'false', 'no', '0', 'deny', 'denied'].includes(value)) {
          handoff = false;
        } else {
          warnings.push(`invalid handoff value "${value}" (valid: on or off)`);
        }
        continue;
      }
      // SOT-1753: `discussion=w1[:m1]+w2[:m2]` names the discussion-mode participants. Not a role
      // chain — `+` joins participants who ALL speak each round (vs `>` = fallback order). Handle it
      // before the role check. Newest occurrence wins.
      if (role === 'discussion') {
        const participants: DiscussionParticipant[] = [];
        for (const tokenRaw of pair.slice(eq + 1).split('+')) {
          const token = tokenRaw.trim();
          if (!token) continue;
          // Same `worker:model` split as role chains: everything after the FIRST colon is the model.
          const colon = token.indexOf(':');
          const workerToken = (colon < 0 ? token : token.slice(0, colon)).trim().toLowerCase();
          const modelToken = colon < 0 ? '' : token.slice(colon + 1).trim();
          const worker = WORKER_ALIASES[workerToken];
          if (!worker) {
            warnings.push(`unknown worker "${workerToken}" for discussion`);
            continue;
          }
          participants.push({ worker, model: modelToken || null });
        }
        if (participants.length === 0) {
          warnings.push('no valid participant specified for discussion');
          continue;
        }
        discussion = participants;
        continue;
      }
      // SOT-1591: `solo=<worker>[:model]` / `solo=off` is a special directive, not a role chain. It sets
      // (or disables) solo mode for this issue. Handle it before the role check. Newest occurrence wins.
      if (role === 'solo') {
        const rhs = pair.slice(eq + 1).trim();
        const rhsLower = rhs.toLowerCase();
        if (rhsLower === 'off' || rhsLower === 'none' || rhsLower === 'false' || rhsLower === '0') {
          solo = { disabled: true };
        } else {
          const colon = rhs.indexOf(':');
          const workerToken = (colon < 0 ? rhs : rhs.slice(0, colon)).trim().toLowerCase();
          const modelToken = colon < 0 ? '' : rhs.slice(colon + 1).trim();
          const worker = WORKER_ALIASES[workerToken];
          if (!worker) {
            warnings.push(`unknown worker "${workerToken}" for solo (valid: claude, codex, antigravity/agy, or 'off')`);
            continue;
          }
          solo = { disabled: false, worker, model: modelToken || null };
        }
        continue;
      }
      if (!isWorkerRole(role)) {
        warnings.push(`unknown role "${role}" (valid: ${WORKER_ROLES.join(', ')})`);
        continue;
      }
      const chain: Worker[] = [];
      const roleModels: Partial<Record<Worker, string>> = {};
      for (const tokenRaw of pair.slice(eq + 1).split(/[>|/]/)) {
        const token = tokenRaw.trim();
        if (!token) continue;
        // Split `worker:model` on the FIRST colon so model ids containing dots/spaces/parens survive.
        const colon = token.indexOf(':');
        const workerToken = (colon < 0 ? token : token.slice(0, colon)).trim().toLowerCase();
        const modelToken = colon < 0 ? '' : token.slice(colon + 1).trim();
        const worker = WORKER_ALIASES[workerToken];
        if (!worker) {
          warnings.push(`unknown worker "${workerToken}" for role "${role}"`);
          continue;
        }
        if (!chain.includes(worker)) chain.push(worker); // de-dupe, preserve order
        if (colon >= 0) {
          if (modelToken) {
            roleModels[worker] = modelToken; // later occurrence in the same line wins
          } else {
            warnings.push(`empty model for worker "${workerToken}" in role "${role}" (using default)`);
          }
        }
      }
      if (chain.length === 0) {
        warnings.push(`no valid worker specified for role "${role}"`);
        continue;
      }
      overrides[role] = chain; // later occurrence overrides earlier
      if (Object.keys(roleModels).length > 0) {
        models[role] = roleModels; // later directive replaces this role's model pins wholesale
      } else {
        delete models[role]; // a newer model-less directive for the role clears any earlier pins
      }
    }
  }
  return { overrides, models, solo, handoff, discussion, warnings };
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
