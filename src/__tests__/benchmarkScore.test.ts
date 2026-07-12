import {
  BenchmarkMetrics,
  DEFAULT_WEIGHTS,
  DecompositionRubric,
  NECESSITY_MISMATCH_PENALTY,
  scoreBenchmarkRun,
  scoreDecompositionRubric,
} from '../lib/benchmarkScore.js';

function baseMetrics(overrides: Partial<BenchmarkMetrics> = {}): BenchmarkMetrics {
  return {
    m1GatePassed: true,
    m2AcceptanceRate: 1,
    m3DebugCycles: 0,
    m4DurationMs: 0,
    m5Interruptions: 0,
    m6DiffAppropriate: true,
    m7HumanIntervention: false,
    m8Quality: 5,
    ...overrides,
  };
}

describe('scoreBenchmarkRun', () => {
  it('gives the max positive score for a perfect, instant run', () => {
    // 40 (gate) + 25 (acceptance) + 15 (diff) + 15 (quality) = 95, minus 0 penalties.
    expect(scoreBenchmarkRun(baseMetrics())).toBe(95);
  });

  it('drops the gate weight when quality gates fail', () => {
    const passed = scoreBenchmarkRun(baseMetrics());
    const failed = scoreBenchmarkRun(baseMetrics({ m1GatePassed: false }));
    expect(passed - failed).toBe(DEFAULT_WEIGHTS.m1Gate);
  });

  it('penalizes debug cycles and interruptions linearly', () => {
    const score = scoreBenchmarkRun(baseMetrics({ m3DebugCycles: 2, m5Interruptions: 1 }));
    expect(score).toBe(95 - DEFAULT_WEIGHTS.m3Debug * 2 - DEFAULT_WEIGHTS.m5Interruption * 1);
  });

  it('penalizes human intervention', () => {
    const score = scoreBenchmarkRun(baseMetrics({ m7HumanIntervention: true }));
    expect(score).toBe(95 - DEFAULT_WEIGHTS.m7Intervention);
  });

  it('normalizes duration against the reference ceiling and clamps overruns', () => {
    const halfway = scoreBenchmarkRun(baseMetrics({ m4DurationMs: 15 * 60 * 1000 }));
    expect(halfway).toBe(95 - DEFAULT_WEIGHTS.m4Duration * 0.5);
    // Beyond the ceiling the duration penalty saturates at the full weight.
    const overrun = scoreBenchmarkRun(baseMetrics({ m4DurationMs: 999 * 60 * 1000 }));
    expect(overrun).toBe(95 - DEFAULT_WEIGHTS.m4Duration);
  });

  it('clamps out-of-range acceptance and quality inputs', () => {
    const score = scoreBenchmarkRun(baseMetrics({ m2AcceptanceRate: 5, m8Quality: 99 }));
    expect(score).toBe(95);
  });
});

describe('scoreDecompositionRubric', () => {
  function baseRubric(overrides: Partial<DecompositionRubric> = {}): DecompositionRubric {
    return {
      r1Necessity: 5,
      r2Granularity: 5,
      r3Independence: 5,
      r4Verifiability: 5,
      r5Naming: 5,
      r6LinkInheritance: 5,
      r7Balance: 5,
      necessityMatchedReference: true,
      ...overrides,
    };
  }

  it('sums R1–R7 into a 7..35 total', () => {
    expect(scoreDecompositionRubric(baseRubric()).total).toBe(35);
    expect(scoreDecompositionRubric(baseRubric({ r1Necessity: 1 })).total).toBe(31);
  });

  it('applies the mismatch penalty when the necessity verdict is wrong', () => {
    const result = scoreDecompositionRubric(baseRubric({ necessityMatchedReference: false }));
    expect(result.total).toBe(35);
    expect(result.effective).toBe(35 - NECESSITY_MISMATCH_PENALTY);
  });

  it('defaults to the seven-axis (required) verdict and reports the applied axes', () => {
    const result = scoreDecompositionRubric(baseRubric());
    expect(result.appliedAxes).toHaveLength(7);
  });

  it('E4: a not-required verdict scores only R1/R6/R7 and ignores the child-shaped axes', () => {
    // Child-shaped axes (R2–R5) are non-applicable for a 不要 verdict, so tanking them must not
    // change the score; the three applicable axes are rescaled onto the comparable 7..35 range.
    const clean = scoreDecompositionRubric(baseRubric({ verdict: 'not-required' }));
    const tanked = scoreDecompositionRubric(
      baseRubric({
        verdict: 'not-required',
        r2Granularity: 1,
        r3Independence: 1,
        r4Verifiability: 1,
        r5Naming: 1,
      }),
    );
    expect(clean.appliedAxes).toEqual(['r1Necessity', 'r6LinkInheritance', 'r7Balance']);
    expect(clean.total).toBe(35);
    expect(tanked.total).toBe(35);
  });

  it('E4: a not-required verdict penalizes only its applicable axes', () => {
    // mean(R1=5, R6=5, R7=2) = 4 → rescaled to 4 * 7 = 28.
    const lowRestraint = scoreDecompositionRubric(baseRubric({ verdict: 'not-required', r7Balance: 2 }));
    expect(lowRestraint.total).toBe(28);
  });
});
