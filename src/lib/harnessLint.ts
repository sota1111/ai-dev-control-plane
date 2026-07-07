/**
 * SOT-1572 harness-lint: machine-checked drift detection between README.md, CLAUDE.md, and
 * config/*.json.
 *
 * The goal is to catch documentation drift (config keys / env knobs added or removed but not
 * reflected in the docs — e.g. lingering references to the removed ALL_CLAUDE_MODE / WORKER_MODE)
 * so CI can fail on it. It deliberately does NOT attempt semantic full-text equivalence of the docs
 * (that over-detects); it runs a small set of deterministic checks. Only a minimal, high-confidence
 * set is `fail`-level (non-zero exit); everything fuzzier is `warn` (surfaced, non-fatal).
 *
 * All logic here is pure — it takes file contents / parsed config as input and returns findings, so
 * it can be unit-tested without touching the filesystem. The thin CLI (scripts/ai/harness_lint.ts)
 * reads the real files and feeds them in.
 */

export type Severity = 'warn' | 'fail';

export interface Finding {
  severity: Severity;
  /** Short stable id of the check that produced this finding. */
  check: string;
  message: string;
}

export interface HarnessLintInputs {
  /** Parsed config/worker_roles.json. */
  workerRoles: Record<string, unknown>;
  /** Raw text of each config/*.json (name = filename, e.g. "incident_response.json"). */
  configTexts: ReadonlyArray<{ name: string; text: string }>;
  /** Raw .env.example contents. */
  envExample: string;
  /** Raw CLAUDE.md contents. */
  claudeMd: string;
  /** Raw README.md contents. */
  readme: string;
  /** Raw text of each scripts/ai/*.sh (name = filename, e.g. "run_auto.sh"). */
  shellScripts: ReadonlyArray<{ name: string; text: string }>;
}

/** The only workers a worker_roles chain may name. */
export const VALID_WORKERS = ['claude', 'codex', 'antigravity'] as const;

/** Knobs removed from the harness that must not linger as live references in the docs. */
export const REMOVED_KNOBS = ['ALL_CLAUDE_MODE', 'WORKER_MODE'] as const;

/** Any UPPER_SNAKE token with at least one underscore (env-var shaped). */
const ENV_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/** A shell env knob read with a default (`${VAR:-…}` / `${VAR:=…}` / `${VAR-…}`) — i.e. tunable. */
const SHELL_KNOB_WITH_DEFAULT = /\$\{([A-Z][A-Z0-9_]*):?[-=][^}]*\}/g;

/**
 * A "major" runtime toggle we expect to be documented: an enable/disable/mode knob. Restricting the
 * fuzzy doc checks to this shape (rather than every UPPER_SNAKE token) is what keeps harness-lint from
 * over-detecting on internal plumbing variables.
 */
export function isControlKnob(name: string): boolean {
  return /_(ENABLED|DISABLED|MODE|REMEDIATE)$/.test(name);
}

/** Line-level qualifier that means a removed-knob mention is intentional (documenting the removal). */
const REMOVAL_QUALIFIER = /(removed|former|no longer|deprecated|廃止|撤廃|かつて)/i;

function uniqueMatches(text: string, pattern: RegExp): string[] {
  const found = new Set<string>();
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.add(m[1] ?? m[0]);
  }
  return [...found];
}

/** Role names declared in config/worker_roles.json (keys starting with `__` are docs, ignored). */
export function configRoleNames(workerRoles: Record<string, unknown>): string[] {
  return Object.keys(workerRoles).filter((k) => !k.startsWith('__'));
}

/** Flatten worker_roles into (role, worker) pairs; a bare string is a single-element chain. */
export function chainWorkers(workerRoles: Record<string, unknown>): Array<{ role: string; worker: string }> {
  const out: Array<{ role: string; worker: string }> = [];
  for (const role of configRoleNames(workerRoles)) {
    const value = workerRoles[role];
    const chain = Array.isArray(value) ? value : [value];
    for (const worker of chain) {
      if (typeof worker === 'string') out.push({ role, worker });
    }
  }
  return out;
}

/**
 * Parse the role names out of CLAUDE.md's "Per-role priority chains" markdown table. Reads the first
 * cell of each data row and extracts its backtick-quoted token (so "`github` (branch/PR/merge)" →
 * "github"). Returns [] if the table is absent.
 */
export function parsePriorityChainTableRoles(claudeMd: string): string[] {
  const lines = claudeMd.split(/\r?\n/);
  const start = lines.findIndex((l) => /Per-role priority chains/i.test(l));
  if (start < 0) return [];
  const roles: string[] = [];
  let inTable = false;
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('|')) {
      inTable = true;
      const cell = (trimmed.split('|')[1] ?? '').trim();
      if (!cell || /^:?-{2,}:?$/.test(cell) || cell.toLowerCase() === 'role') continue;
      const backtick = cell.match(/`([^`]+)`/);
      const role = (backtick ? backtick[1] : cell.split(/\s+/)[0]).trim();
      if (role) roles.push(role);
    } else if (inTable) {
      break; // the table ended (blank line or following prose)
    }
  }
  return roles;
}

/** Env var names declared in .env.example, including commented examples (`# NAME=…`). */
export function envDeclarations(envExample: string): Set<string> {
  const set = new Set<string>();
  for (const line of envExample.split(/\r?\n/)) {
    const m = line.match(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (m) set.add(m[1]);
  }
  return set;
}

/** Tunable env knobs read with a default in a shell script. */
export function extractShellKnobs(text: string): string[] {
  return uniqueMatches(text, SHELL_KNOB_WITH_DEFAULT).filter((k) => k.includes('_'));
}

/**
 * FAIL: every role in config/worker_roles.json must appear in CLAUDE.md's Per-role priority chains
 * table, and vice-versa. This catches a role added/removed in one place but not the other.
 */
export function checkRolesVsTable(inputs: HarnessLintInputs): Finding[] {
  const findings: Finding[] = [];
  const check = 'roles-vs-claudemd-table';
  const configRoles = new Set(configRoleNames(inputs.workerRoles));
  const tableRoles = new Set(parsePriorityChainTableRoles(inputs.claudeMd));
  if (tableRoles.size === 0) {
    findings.push({ severity: 'fail', check, message: 'CLAUDE.md "Per-role priority chains" table not found or empty' });
    return findings;
  }
  for (const r of configRoles) {
    if (!tableRoles.has(r)) {
      findings.push({ severity: 'fail', check, message: `role "${r}" in config/worker_roles.json is missing from the CLAUDE.md Per-role priority chains table` });
    }
  }
  for (const r of tableRoles) {
    if (!configRoles.has(r)) {
      findings.push({ severity: 'fail', check, message: `role "${r}" in the CLAUDE.md Per-role priority chains table is not defined in config/worker_roles.json` });
    }
  }
  return findings;
}

/** FAIL: every worker named in a chain must be one of VALID_WORKERS. */
export function checkWorkerNames(inputs: HarnessLintInputs): Finding[] {
  const valid = new Set<string>(VALID_WORKERS);
  const findings: Finding[] = [];
  for (const { role, worker } of chainWorkers(inputs.workerRoles)) {
    if (!valid.has(worker)) {
      findings.push({ severity: 'fail', check: 'worker-names', message: `unknown worker "${worker}" in chain for role "${role}" (valid: ${VALID_WORKERS.join(', ')})` });
    }
  }
  return findings;
}

/**
 * WARN: runtime enable/disable/mode knobs referenced in config/*.json should be documented in
 * .env.example. Warn-only: some knobs live only in the deploy environment by design.
 */
export function checkConfigEnvKnobs(inputs: HarnessLintInputs): Finding[] {
  const declared = envDeclarations(inputs.envExample);
  const findings: Finding[] = [];
  for (const { name, text } of inputs.configTexts) {
    for (const knob of uniqueMatches(text, ENV_TOKEN)) {
      if (isControlKnob(knob) && !declared.has(knob)) {
        findings.push({ severity: 'warn', check: 'config-env-in-envexample', message: `config/${name} references env knob ${knob} which is not declared in .env.example` });
      }
    }
  }
  return findings;
}

/** WARN: each worker_roles role should be mentioned somewhere in README.md. */
export function checkRolesInReadme(inputs: HarnessLintInputs): Finding[] {
  const findings: Finding[] = [];
  for (const role of configRoleNames(inputs.workerRoles)) {
    if (!inputs.readme.includes(role)) {
      findings.push({ severity: 'warn', check: 'roles-in-readme', message: `role "${role}" is not mentioned in README.md` });
    }
  }
  return findings;
}

/** WARN: a removed knob appearing in the docs without a removal note is likely stale residue. */
export function checkRemovedKnobResidue(inputs: HarnessLintInputs): Finding[] {
  const findings: Finding[] = [];
  const docs = [
    { name: 'CLAUDE.md', text: inputs.claudeMd },
    { name: 'README.md', text: inputs.readme },
  ];
  for (const { name, text } of docs) {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (REMOVAL_QUALIFIER.test(line)) return;
      for (const knob of REMOVED_KNOBS) {
        if (line.includes(knob)) {
          findings.push({ severity: 'warn', check: 'removed-knob-residue', message: `${name}:${idx + 1} references removed knob ${knob} without a removal note` });
        }
      }
    });
  }
  return findings;
}

/**
 * WARN: env knobs read with a default in scripts/ai/*.sh should be mentioned in CLAUDE.md, README.md,
 * or .env.example. Best-effort (many internal shell vars) — hence warn-only, per the issue spec.
 */
export function checkShellEnvDocumented(inputs: HarnessLintInputs): Finding[] {
  const declared = envDeclarations(inputs.envExample);
  const mentioned = (knob: string): boolean =>
    inputs.claudeMd.includes(knob) || inputs.readme.includes(knob) || declared.has(knob);
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const { name, text } of inputs.shellScripts) {
    for (const knob of extractShellKnobs(text)) {
      if (isControlKnob(knob) && !mentioned(knob) && !seen.has(knob)) {
        seen.add(knob);
        findings.push({ severity: 'warn', check: 'shell-env-doc', message: `env knob ${knob} (read in scripts/ai/${name}) is not mentioned in CLAUDE.md, README.md, or .env.example` });
      }
    }
  }
  return findings;
}

/** Run every drift check and return all findings. */
export function lintHarness(inputs: HarnessLintInputs): Finding[] {
  return [
    ...checkRolesVsTable(inputs),
    ...checkWorkerNames(inputs),
    ...checkConfigEnvKnobs(inputs),
    ...checkRolesInReadme(inputs),
    ...checkRemovedKnobResidue(inputs),
    ...checkShellEnvDocumented(inputs),
  ];
}

/** True iff any finding is fail-level (drives the CLI exit code / CI gate). */
export function hasFailures(findings: ReadonlyArray<Finding>): boolean {
  return findings.some((f) => f.severity === 'fail');
}
