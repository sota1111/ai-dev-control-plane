// SOT-1549: unit tests for per-leg metrics shaping/aggregation (src/lib/legMetrics.ts).

import {
  aggregateLegs,
  buildGate,
  buildLegMetrics,
  EMPTY_DIFF,
  EMPTY_GATE,
  legMetricsFilename,
  parseNumstat,
} from '../lib/legMetrics.js';

describe('parseNumstat (M6)', () => {
  it('sums insertions/deletions and counts files', () => {
    const out = parseNumstat('10\t2\tsrc/a.ts\n3\t0\tsrc/b.ts\n');
    expect(out).toEqual({ files: 2, insertions: 13, deletions: 2 });
  });

  it('treats binary rows (-) as a changed file with 0 line deltas', () => {
    const out = parseNumstat('-\t-\tassets/logo.png\n5\t1\tsrc/a.ts\n');
    expect(out).toEqual({ files: 2, insertions: 5, deletions: 1 });
  });

  it('returns an empty diff for empty input', () => {
    expect(parseNumstat('')).toEqual(EMPTY_DIFF);
    expect(parseNumstat('\n  \n')).toEqual(EMPTY_DIFF);
  });
});

describe('buildGate (M1 breakdown)', () => {
  it('maps exit codes 0→true, nonzero→false', () => {
    const gate = buildGate({ lint: 0, typecheck: 0, test: 1 });
    expect(gate.lint).toBe(true);
    expect(gate.typecheck).toBe(true);
    expect(gate.test).toBe(false);
    expect(gate.e2e).toBeNull();
  });

  it('passed is true only when every collected sub-gate passed', () => {
    expect(buildGate({ lint: 0, typecheck: 0, test: 0 }).passed).toBe(true);
    expect(buildGate({ lint: 0, typecheck: 0, test: 1 }).passed).toBe(false);
  });

  it('passed is null when no sub-gate was collected (the old null-m1 case)', () => {
    expect(buildGate({}).passed).toBeNull();
    expect(buildGate()).toEqual(EMPTY_GATE);
  });
});

describe('buildLegMetrics', () => {
  const base = {
    issue: 'SOT-1549',
    role: 'verification',
    worker: 'codex',
    exitCode: 0,
    startMs: 1_730_000_000_000,
    endMs: 1_730_000_060_000,
  };

  it('produces a schema-compliant leg with M1 breakdown filled from exit codes', () => {
    const leg = buildLegMetrics({
      ...base,
      sequence: 1,
      numstat: '4\t1\tsrc/a.ts\n',
      gate: { lint: 0, typecheck: 0, test: 0 },
      handoffFrom: 'antigravity',
      reportPath: 'docs/ai/60_worker_codex_report.md',
      repo: '/workspaces/foo',
    });

    // Schema shape.
    expect(Object.keys(leg).sort()).toEqual(
      [
        'endedAt',
        'exitCode',
        'handoffFrom',
        'issue',
        'm1GatePass',
        'm4DurationMs',
        'm5Interruptions',
        'm6Diff',
        'reportPath',
        'repo',
        'role',
        'sequence',
        'startedAt',
        'worker',
      ].sort(),
    );

    // M1 breakdown is populated (not null) — the core fix of SOT-1549.
    expect(leg.m1GatePass).toEqual({
      passed: true,
      lint: true,
      typecheck: true,
      test: true,
      e2e: null,
    });
    // M4 duration.
    expect(leg.m4DurationMs).toBe(60_000);
    // M5 interruptions == sequence (handoffs preceding this leg).
    expect(leg.m5Interruptions).toBe(1);
    // M6 diff.
    expect(leg.m6Diff).toEqual({ files: 1, insertions: 4, deletions: 1 });
    expect(leg.handoffFrom).toBe('antigravity');
    expect(leg.startedAt).toBe('2024-10-27T03:33:20.000Z');
  });

  it('defaults: sequence 0, empty diff, empty gate, null optionals', () => {
    const leg = buildLegMetrics(base);
    expect(leg.sequence).toBe(0);
    expect(leg.m5Interruptions).toBe(0);
    expect(leg.m6Diff).toEqual(EMPTY_DIFF);
    expect(leg.m1GatePass).toEqual(EMPTY_GATE);
    expect(leg.handoffFrom).toBeNull();
    expect(leg.reportPath).toBeNull();
  });

  it('clamps negative durations to 0', () => {
    const leg = buildLegMetrics({ ...base, startMs: 100, endMs: 50 });
    expect(leg.m4DurationMs).toBe(0);
  });
});

describe('aggregateLegs', () => {
  it('sums M4/M5/M6 and dedupes workers', () => {
    const legs = [
      buildLegMetrics({
        issue: 'X',
        role: 'implementation',
        worker: 'antigravity',
        exitCode: 75,
        startMs: 0,
        endMs: 2_000,
        sequence: 0,
        numstat: '1\t0\ta.ts\n',
      }),
      buildLegMetrics({
        issue: 'X',
        role: 'implementation',
        worker: 'codex',
        exitCode: 0,
        startMs: 0,
        endMs: 3_000,
        sequence: 1,
        numstat: '5\t2\tb.ts\n',
        gate: { lint: 0, typecheck: 0, test: 0 },
      }),
    ];
    const agg = aggregateLegs(legs);
    expect(agg.legs).toBe(2);
    expect(agg.totalDurationMs).toBe(5_000);
    expect(agg.totalInterruptions).toBe(1);
    expect(agg.diff).toEqual({ files: 2, insertions: 6, deletions: 2 });
    expect(agg.workers).toEqual(['antigravity', 'codex']);
    expect(agg.gate.passed).toBe(true);
  });

  it('combined gate fails when any leg gate fails, null when none collected', () => {
    const pass = buildLegMetrics({
      issue: 'X', role: 'verification', worker: 'codex',
      exitCode: 0, startMs: 0, endMs: 1, gate: { lint: 0 },
    });
    const fail = buildLegMetrics({
      issue: 'X', role: 'verification', worker: 'claude',
      exitCode: 0, startMs: 0, endMs: 1, gate: { lint: 1 },
    });
    expect(aggregateLegs([pass, fail]).gate.lint).toBe(false);
    const none = buildLegMetrics({
      issue: 'X', role: 'verification', worker: 'codex',
      exitCode: 0, startMs: 0, endMs: 1,
    });
    expect(aggregateLegs([none]).gate.passed).toBeNull();
  });
});

describe('legMetricsFilename', () => {
  it('builds a filesystem-safe, deterministic name', () => {
    const name = legMetricsFilename({
      issue: 'SOT-1549',
      role: 'implementation',
      worker: 'codex',
      sequence: 0,
      endedAt: '2024-10-27T04:53:20.000Z',
    });
    expect(name).toBe('leg-SOT-1549-implementation-codex-0-20241027T045320000Z.json');
  });

  it('falls back when issue is null', () => {
    const name = legMetricsFilename({
      issue: null,
      role: 'github',
      worker: 'claude',
      sequence: 2,
      endedAt: '2024-10-27T04:53:20.000Z',
    });
    expect(name.startsWith('leg-no-issue-github-claude-2-')).toBe(true);
  });
});
