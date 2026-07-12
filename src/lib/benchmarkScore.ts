// SOT-1531: worker performance benchmark scoring.
//
// The worker-comparison benchmark (see docs/ai/20_design.md) runs the same task through different
// worker×role combinations and records the M1–M8 metrics per run. This module turns those recorded
// metrics into a single composite score so runs can be ranked apples-to-apples AFTER the fact — i.e.
// a human or Claude reviewer fills the metric fields from the run logs and calls scoreBenchmarkRun()
// rather than eyeballing the table. It also scores the decomposition qualitative rubric (R1–R7).
//
// This is pure, deterministic, dependency-free logic so it can be unit-tested and re-run on recorded
// data at any time. It performs NO worker dispatch and reads NO external state.

/** Metrics recorded for one benchmark run (M1–M8 in docs/ai/20_design.md §2). */
export interface BenchmarkMetrics {
  /** M1: all applicable quality gates passed (lint/typecheck/test/e2e). */
  m1GatePassed: boolean;
  /** M2: acceptance-criteria satisfaction rate, 0..1. */
  m2AcceptanceRate: number;
  /** M3: number of verification→implementation debug cycles (lower is better). */
  m3DebugCycles: number;
  /** M4: wall-clock duration in ms (lower is better; normalized against maxDurationMs). */
  m4DurationMs: number;
  /** M5: usage-limit hits / exit-75 handoffs (lower is better). */
  m5Interruptions: number;
  /** M6: diff size was appropriate with no stray/unintended changes. */
  m6DiffAppropriate: boolean;
  /** M7: the run stopped needing human input (BLOCKED/NEEDS_USER_INPUT). */
  m7HumanIntervention: boolean;
  /** M8: qualitative reviewer score, 1..5. */
  m8Quality: number;
}

/** Weights for the composite score. Defaults mirror the example in docs/ai/20_design.md §2. */
export interface ScoreWeights {
  m1Gate: number;
  m2Acceptance: number;
  m3Debug: number;
  m4Duration: number;
  m5Interruption: number;
  m6Diff: number;
  m7Intervention: number;
  m8Quality: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  m1Gate: 40,
  m2Acceptance: 25,
  m3Debug: 5,
  m4Duration: 10,
  m5Interruption: 5,
  m6Diff: 15,
  m7Intervention: 20,
  m8Quality: 15,
};

/** Reference ceiling used to normalize M4 duration into 0..1. Default 30 min. */
export const DEFAULT_MAX_DURATION_MS = 30 * 60 * 1000;

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Composite score for one benchmark run. Higher is better. Positive terms reward gate pass,
 * acceptance rate, appropriate diff, and quality; negative terms penalize debug cycles, slow
 * runs, interruptions, and human intervention. See docs/ai/20_design.md §2.
 */
export function scoreBenchmarkRun(
  metrics: BenchmarkMetrics,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
  maxDurationMs: number = DEFAULT_MAX_DURATION_MS,
): number {
  const acceptance = clamp(metrics.m2AcceptanceRate, 0, 1);
  const quality = clamp(metrics.m8Quality, 1, 5);
  const durationNorm = clamp(metrics.m4DurationMs / maxDurationMs, 0, 1);

  const score =
    weights.m1Gate * (metrics.m1GatePassed ? 1 : 0) +
    weights.m2Acceptance * acceptance -
    weights.m3Debug * Math.max(0, metrics.m3DebugCycles) -
    weights.m4Duration * durationNorm -
    weights.m5Interruption * Math.max(0, metrics.m5Interruptions) +
    weights.m6Diff * (metrics.m6DiffAppropriate ? 1 : 0) -
    weights.m7Intervention * (metrics.m7HumanIntervention ? 1 : 0) +
    weights.m8Quality * (quality / 5);

  return Math.round(score * 100) / 100;
}

/** The decomposition verdict a run produced (分解判断). */
export type DecompositionVerdict = 'required' | 'not-required';

/** Decomposition qualitative rubric R1–R7, each 1..5 (docs/ai/20_design.md §7.3). */
export interface DecompositionRubric {
  r1Necessity: number;
  r2Granularity: number;
  r3Independence: number;
  r4Verifiability: number;
  r5Naming: number;
  r6LinkInheritance: number;
  r7Balance: number;
  /** Whether the necessity verdict matched the reference answer (要否一致). */
  necessityMatchedReference: boolean;
  /**
   * E4 (docs/ai/experiments/SOT-1531-analysis.md §2): the decomposition verdict. When 'not-required'
   * there are no child issues, so the child-shaped axes — R2 granularity, R3 independence,
   * R4 verifiability, R5 naming — are non-applicable and scoring them (e.g. "満点扱い") inflates the
   * result. Only R1 (verdict soundness), R6 (parent comment / state sync), and R7 (restraint against
   * over-splitting) apply. Defaults to 'required' (all seven axes) for backward compatibility.
   */
  verdict?: DecompositionVerdict;
}

export interface DecompositionScore {
  /**
   * Applicable rubric axes normalized onto the full 7..35 scale so verdicts are comparable. For a
   * 'required' verdict (all seven axes) this equals the raw R1–R7 sum exactly; for 'not-required'
   * it is the per-axis mean of the applicable axes rescaled to 7..35.
   */
  total: number;
  /**
   * Effective score. When the necessity verdict disagrees with the reference answer the run is
   * heavily penalized regardless of the other axes (decomposition's primary job is the verdict).
   */
  effective: number;
  necessityMatchedReference: boolean;
  /** Which rubric axes were applied (verdict-dependent — see E4). */
  appliedAxes: (keyof DecompositionRubric)[];
}

const RUBRIC_KEYS: (keyof DecompositionRubric)[] = [
  'r1Necessity',
  'r2Granularity',
  'r3Independence',
  'r4Verifiability',
  'r5Naming',
  'r6LinkInheritance',
  'r7Balance',
];

/** Axes that still apply when the verdict is 'not-required' (no child issues exist to grade). */
const NOT_REQUIRED_AXES: (keyof DecompositionRubric)[] = [
  'r1Necessity',
  'r6LinkInheritance',
  'r7Balance',
];

function applicableAxes(verdict: DecompositionVerdict): (keyof DecompositionRubric)[] {
  return verdict === 'not-required' ? NOT_REQUIRED_AXES : RUBRIC_KEYS;
}

/** Penalty subtracted from the effective score when the necessity verdict is wrong. */
export const NECESSITY_MISMATCH_PENALTY = 14;

export function scoreDecompositionRubric(rubric: DecompositionRubric): DecompositionScore {
  const verdict: DecompositionVerdict = rubric.verdict ?? 'required';
  const axes = applicableAxes(verdict);
  const sum = axes.reduce((acc, key) => acc + clamp(rubric[key] as number, 1, 5), 0);
  // Rescale the applicable axes' per-axis mean (1..5) onto the full seven-axis range (7..35) so a
  // 'not-required' run graded on three axes is comparable to a 'required' run graded on seven. For
  // the full seven-axis case mean * 7 === sum, preserving the prior raw-sum behavior exactly.
  const total = Math.round((sum / axes.length) * 7 * 100) / 100;
  const effective = rubric.necessityMatchedReference
    ? total
    : total - NECESSITY_MISMATCH_PENALTY;
  return {
    total,
    effective,
    necessityMatchedReference: rubric.necessityMatchedReference,
    appliedAxes: axes,
  };
}
