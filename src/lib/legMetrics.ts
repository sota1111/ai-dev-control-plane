// SOT-1549: per-leg metrics auto-emitted by the dispatcher (scripts/ai/run_worker.sh).
//
// A "leg" is one worker attempt for one role — a single iteration of run_worker.sh's chain loop
// (role × worker). The dispatcher — NOT an AI — records the objective metrics as a side-effect of
// running the leg and calls into this pure module to shape them into a schema-stable JSON written to
// docs/ai/auto_logs/metrics/. This replaces the hand-written metrics JSON that run_benchmark.sh could
// not produce from inside a dispatched worker ("AI does not call AI" — run_benchmark.sh refuses when
// RUN_WORKER_DISPATCH=1). The previously hand-transcribed files also left `m1GatePass: null`; here the
// M1 gate is a structured breakdown filled from real lint/typecheck/test exit codes.
// See docs/ai/experiments/SOT-1537-system-improvements.md P2-2.
//
// Pure, deterministic, dependency-free so it is unit-testable and reproducible on recorded values.
// It performs NO worker dispatch and reads NO external state.

/** M6: change size of a leg (from `git diff --numstat`). */
export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * M1: quality-gate breakdown. Each sub-gate is true (passed), false (failed), or null (not run in
 * this leg). `passed` is the roll-up: true iff every collected sub-gate passed, null when none were
 * collected. This is the field that used to be a bare `null` in the hand-written metrics.
 */
export interface M1Gate {
  passed: boolean | null;
  lint: boolean | null;
  typecheck: boolean | null;
  test: boolean | null;
  e2e: boolean | null;
}

/** Exit codes captured for the quality-gate sub-commands (undefined/null ⇒ the gate was not run). */
export interface GateExitCodes {
  lint?: number | null;
  typecheck?: number | null;
  test?: number | null;
  e2e?: number | null;
}

/** Fully shaped metrics for one dispatcher leg. */
export interface LegMetrics {
  issue: string | null;
  role: string;
  worker: string;
  /** 0-based position of this leg within the role's chain (0 = primary, ≥1 = after a handoff). */
  sequence: number;
  exitCode: number;
  /** M1: quality-gate breakdown (lint/typecheck/test/e2e). */
  m1GatePass: M1Gate;
  /** M4: wall-clock duration of the leg in ms. */
  m4DurationMs: number;
  /** M5: handoffs preceding this leg (equals `sequence`: a leg at index k followed k handoffs). */
  m5Interruptions: number;
  /** M6: diff size of the leg relative to its pre-leg baseline. */
  m6Diff: DiffStat;
  handoffFrom: string | null;
  reportPath: string | null;
  repo: string | null;
  startedAt: string;
  endedAt: string;
}

export const EMPTY_DIFF: DiffStat = { files: 0, insertions: 0, deletions: 0 };
export const EMPTY_GATE: M1Gate = {
  passed: null,
  lint: null,
  typecheck: null,
  test: null,
  e2e: null,
};

/**
 * Parse `git diff --numstat` output into a DiffStat. Each line is `<added>\t<deleted>\t<path>`.
 * Binary files render added/deleted as `-`; those count as a changed file with 0 line deltas.
 */
export function parseNumstat(numstat: string): DiffStat {
  const stat: DiffStat = { files: 0, insertions: 0, deletions: 0 };
  for (const rawLine of numstat.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    stat.files += 1;
    const add = Number(parts[0]);
    const del = Number(parts[1]);
    if (Number.isFinite(add)) stat.insertions += add;
    if (Number.isFinite(del)) stat.deletions += del;
  }
  return stat;
}

/** Map a command exit code to a gate boolean: 0 → true, other → false, null/undefined → null. */
function gateBool(code: number | null | undefined): boolean | null {
  if (code === null || code === undefined) return null;
  return code === 0;
}

/**
 * Build the M1 gate breakdown from the sub-command exit codes. `passed` is null when no sub-gate was
 * run, otherwise true iff every collected sub-gate passed.
 */
export function buildGate(codes: GateExitCodes = {}): M1Gate {
  const lint = gateBool(codes.lint);
  const typecheck = gateBool(codes.typecheck);
  const test = gateBool(codes.test);
  const e2e = gateBool(codes.e2e);
  const collected = [lint, typecheck, test, e2e].filter(
    (v): v is boolean => v !== null,
  );
  const passed = collected.length === 0 ? null : collected.every(Boolean);
  return { passed, lint, typecheck, test, e2e };
}

export interface LegMetricsInput {
  issue?: string | null;
  role: string;
  worker: string;
  sequence?: number;
  exitCode: number;
  /** Epoch-ms start/end of the leg (M4 = end - start). */
  startMs: number;
  endMs: number;
  /** Raw `git diff --numstat` output for M6 (empty ⇒ no change). */
  numstat?: string;
  /** Gate sub-command exit codes for M1 (omit ⇒ gate not collected). */
  gate?: GateExitCodes;
  handoffFrom?: string | null;
  reportPath?: string | null;
  repo?: string | null;
}

function isoOrEpoch(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(0).toISOString();
}

/** Shape one leg's raw measurements into the stable LegMetrics schema. */
export function buildLegMetrics(input: LegMetricsInput): LegMetrics {
  const sequence = Math.max(0, Math.trunc(input.sequence ?? 0));
  const duration = Math.max(0, Math.trunc(input.endMs - input.startMs));
  return {
    issue: input.issue ?? null,
    role: input.role,
    worker: input.worker,
    sequence,
    exitCode: Math.trunc(input.exitCode),
    m1GatePass: buildGate(input.gate),
    m4DurationMs: duration,
    m5Interruptions: sequence,
    m6Diff: input.numstat ? parseNumstat(input.numstat) : { ...EMPTY_DIFF },
    handoffFrom: input.handoffFrom || null,
    reportPath: input.reportPath || null,
    repo: input.repo || null,
    startedAt: isoOrEpoch(input.startMs),
    endedAt: isoOrEpoch(input.endMs),
  };
}

/** Roll-up over several legs (e.g. all legs of one role, or a whole pipeline run). */
export interface LegAggregate {
  legs: number;
  totalDurationMs: number;
  totalInterruptions: number;
  diff: DiffStat;
  gate: M1Gate;
  workers: string[];
}

function combineGate(a: M1Gate, b: M1Gate): M1Gate {
  const merge = (x: boolean | null, y: boolean | null): boolean | null => {
    if (x === null) return y;
    if (y === null) return x;
    return x && y;
  };
  return {
    passed: merge(a.passed, b.passed),
    lint: merge(a.lint, b.lint),
    typecheck: merge(a.typecheck, b.typecheck),
    test: merge(a.test, b.test),
    e2e: merge(a.e2e, b.e2e),
  };
}

/** Aggregate legs: sum M4/M5/M6 and combine the M1 gate (passed iff every collected gate passed). */
export function aggregateLegs(legs: LegMetrics[]): LegAggregate {
  const agg: LegAggregate = {
    legs: legs.length,
    totalDurationMs: 0,
    totalInterruptions: 0,
    diff: { ...EMPTY_DIFF },
    gate: { ...EMPTY_GATE },
    workers: [],
  };
  const seen = new Set<string>();
  for (const leg of legs) {
    agg.totalDurationMs += Math.max(0, leg.m4DurationMs);
    agg.totalInterruptions += Math.max(0, leg.m5Interruptions);
    agg.diff.files += leg.m6Diff.files;
    agg.diff.insertions += leg.m6Diff.insertions;
    agg.diff.deletions += leg.m6Diff.deletions;
    agg.gate = combineGate(agg.gate, leg.m1GatePass);
    if (!seen.has(leg.worker)) {
      seen.add(leg.worker);
      agg.workers.push(leg.worker);
    }
  }
  return agg;
}

/** Default filename for a leg's metrics JSON (single source of truth for the naming scheme). */
export function legMetricsFilename(leg: {
  issue: string | null;
  role: string;
  worker: string;
  sequence: number;
  endedAt: string;
}): string {
  const slug = (s: string) => (s || 'unknown').replace(/[^A-Za-z0-9_-]+/g, '-');
  const ts = leg.endedAt.replace(/[:.]/g, '').replace(/-/g, '');
  return `leg-${slug(leg.issue ?? 'no-issue')}-${slug(leg.role)}-${slug(leg.worker)}-${leg.sequence}-${ts}.json`;
}
