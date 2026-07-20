import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateReleaseGate, writeReleaseGateArtifacts } from '../lib/ptcgReleaseGate.js';
import type { StatisticalBenchmarkReport } from '../lib/ptcgStatisticalBenchmark.js';

const benchmark = (passed = true): StatisticalBenchmarkReport => ({
  schemaVersion: 'ptcg-statistical-benchmark/v1',
  generatedAt: '2026-07-20T00:00:00.000Z',
  baselineVersion: 'v1',
  policy: { confidenceLevel: 0.95, equivalenceMargin: 0.1, minimumGames: 100 },
  conditionsFingerprint: 'fixed-conditions',
  candidateProtocolFingerprint: 'candidate',
  baselineProtocolFingerprint: 'baseline',
  results: [
    {
      methodId: 'candidate',
      games: { candidate: 100, baseline: 100 },
      winRate: { candidate: 0.5, baseline: 0.5, difference: 0 },
      confidenceInterval95: { low: -0.1, high: 0.1, method: 'newcombe-wilson' },
      classification: passed ? 'equivalent' : 'regressed',
      passed,
      rationale: 'fixture',
    },
  ],
  passed,
});

describe('PTCG release gate', () => {
  it('passes correctness, performance, and information leakage together', () => {
    const report = evaluateReleaseGate({
      generatedAt: '2026-07-20T00:00:00.000Z',
      mode: 'smoke',
      benchmark: benchmark(),
      durationMs: 20,
      maximumDurationMs: 100,
      artifact: { owner: 'anonymous', result: 'clean' },
    });
    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual([
      'correctness',
      'performance',
      'information-leakage',
    ]);
  });

  it.each([
    ['correctness', benchmark(false), 20, { result: 'clean' }],
    ['performance', benchmark(), 101, { result: 'clean' }],
    ['information-leakage', benchmark(), 20, { token: 'secret-value' }],
  ] as const)('fails when the %s gate fails', (name, result, durationMs, artifact) => {
    const report = evaluateReleaseGate({
      generatedAt: '2026-07-20T00:00:00.000Z',
      mode: 'scheduled',
      benchmark: result,
      durationMs,
      maximumDurationMs: 100,
      artifact,
    });
    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.name === name)?.passed).toBe(false);
  });

  it('writes machine-readable evidence and a review dashboard', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-'));
    const report = evaluateReleaseGate({
      generatedAt: '2026-07-20T00:00:00.000Z',
      mode: 'smoke',
      benchmark: benchmark(),
      durationMs: 20,
      maximumDurationMs: 100,
      artifact: {},
    });
    const files = writeReleaseGateArtifacts(dir, report);
    expect(JSON.parse(fs.readFileSync(files.json, 'utf8'))).toEqual(report);
    expect(fs.readFileSync(files.markdown, 'utf8')).toContain('| correctness | PASS |');
  });
});
