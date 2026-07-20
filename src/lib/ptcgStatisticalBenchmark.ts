import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EvaluationRun } from './ptcgEvaluationHarness.js';

export const STATISTICAL_BENCHMARK_SCHEMA = 'ptcg-statistical-benchmark/v1' as const;

export type BenchmarkClassification = 'improved' | 'equivalent' | 'regressed' | 'inconclusive';

export interface BenchmarkPolicy {
  confidenceLevel: 0.95;
  /** Smallest win-rate change considered practically meaningful. */
  equivalenceMargin: number;
  /** Minimum games required for both candidate and baseline. */
  minimumGames: number;
}

export interface VersionedBenchmarkBaseline {
  schemaVersion: typeof STATISTICAL_BENCHMARK_SCHEMA;
  baselineVersion: string;
  createdAt: string;
  run: EvaluationRun;
}

export interface BenchmarkMethodResult {
  methodId: string;
  games: { candidate: number; baseline: number };
  winRate: { candidate: number; baseline: number; difference: number };
  confidenceInterval95: { low: number; high: number; method: 'newcombe-wilson' };
  classification: BenchmarkClassification;
  passed: boolean;
  rationale: string;
}

export interface StatisticalBenchmarkReport {
  schemaVersion: typeof STATISTICAL_BENCHMARK_SCHEMA;
  generatedAt: string;
  baselineVersion: string;
  policy: BenchmarkPolicy;
  conditionsFingerprint: string;
  candidateProtocolFingerprint: string;
  baselineProtocolFingerprint: string;
  results: BenchmarkMethodResult[];
  passed: boolean;
}

const DEFAULT_POLICY: BenchmarkPolicy = {
  confidenceLevel: 0.95,
  equivalenceMargin: 0.02,
  minimumGames: 100,
};

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function stableConditions(run: EvaluationRun): string {
  const { methods: _methods, ...conditions } = run.protocol;
  return crypto.createHash('sha256').update(JSON.stringify(conditions)).digest('hex');
}

function wilson(successes: number, total: number): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 1 };
  const z = 1.959963984540054;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const radius = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denominator;
  return { low: center - radius, high: center + radius };
}

function methodStats(run: EvaluationRun, methodId: string): { wins: number; games: number } {
  const rows = run.results.filter((result) => result.methodId === methodId);
  return {
    wins: rows.filter((result) => result.outcome.winner === 'method').length,
    games: rows.length,
  };
}

function classify(
  low: number,
  high: number,
  policy: BenchmarkPolicy,
  enoughGames: boolean
): Pick<BenchmarkMethodResult, 'classification' | 'passed' | 'rationale'> {
  if (!enoughGames)
    return {
      classification: 'inconclusive',
      passed: false,
      rationale: 'minimum game count not met',
    };
  if (low > policy.equivalenceMargin)
    return {
      classification: 'improved',
      passed: true,
      rationale: '95% CI is wholly above the improvement threshold',
    };
  if (high < -policy.equivalenceMargin)
    return {
      classification: 'regressed',
      passed: false,
      rationale: '95% CI is wholly below the regression threshold',
    };
  if (low >= -policy.equivalenceMargin && high <= policy.equivalenceMargin)
    return {
      classification: 'equivalent',
      passed: true,
      rationale: '95% CI is contained within the equivalence margin',
    };
  return {
    classification: 'inconclusive',
    passed: false,
    rationale: '95% CI crosses a decision boundary',
  };
}

/** Compare candidate and versioned baseline under identical fixed seed/deck/pool/trial conditions. */
export function compareWithBaseline(
  candidate: EvaluationRun,
  baseline: VersionedBenchmarkBaseline,
  generatedAt: string,
  policy: BenchmarkPolicy = DEFAULT_POLICY
): StatisticalBenchmarkReport {
  if (!baseline.baselineVersion.trim()) throw new Error('baselineVersion is required');
  if (
    !Number.isFinite(policy.equivalenceMargin) ||
    policy.equivalenceMargin < 0 ||
    policy.equivalenceMargin >= 1
  )
    throw new Error('equivalenceMargin must be in [0, 1)');
  if (!Number.isSafeInteger(policy.minimumGames) || policy.minimumGames < 1)
    throw new Error('minimumGames must be a positive safe integer');
  const candidateConditions = stableConditions(candidate);
  const baselineConditions = stableConditions(baseline.run);
  if (candidateConditions !== baselineConditions)
    throw new Error(
      'candidate and baseline conditions differ (environment, seed, repetitions, deck, or opponent pool)'
    );

  const baselineMethods = new Set(baseline.run.protocol.methods.map((method) => method.id));
  const methodIds = candidate.protocol.methods.map((method) => method.id).sort();
  for (const methodId of methodIds)
    if (!baselineMethods.has(methodId))
      throw new Error(`method ${methodId} is absent from baseline`);

  const results = methodIds.map((methodId): BenchmarkMethodResult => {
    const current = methodStats(candidate, methodId);
    const previous = methodStats(baseline.run, methodId);
    const currentRate = current.games ? current.wins / current.games : 0;
    const previousRate = previous.games ? previous.wins / previous.games : 0;
    const currentWilson = wilson(current.wins, current.games);
    const previousWilson = wilson(previous.wins, previous.games);
    // Newcombe's independent-proportions interval: combine the two Wilson score intervals.
    const low = currentWilson.low - previousWilson.high;
    const high = currentWilson.high - previousWilson.low;
    const verdict = classify(
      low,
      high,
      policy,
      current.games >= policy.minimumGames && previous.games >= policy.minimumGames
    );
    return {
      methodId,
      games: { candidate: current.games, baseline: previous.games },
      winRate: {
        candidate: round(currentRate),
        baseline: round(previousRate),
        difference: round(currentRate - previousRate),
      },
      confidenceInterval95: { low: round(low), high: round(high), method: 'newcombe-wilson' },
      ...verdict,
    };
  });
  return {
    schemaVersion: STATISTICAL_BENCHMARK_SCHEMA,
    generatedAt,
    baselineVersion: baseline.baselineVersion,
    policy: structuredClone(policy),
    conditionsFingerprint: candidateConditions,
    candidateProtocolFingerprint: candidate.protocolFingerprint,
    baselineProtocolFingerprint: baseline.run.protocolFingerprint,
    results,
    passed: results.every((result) => result.passed),
  };
}

/** Atomic, stable pretty-JSON output suitable for scheduled benchmark retention. */
export function writeBenchmarkReport(file: string, report: StatisticalBenchmarkReport): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(temp, file);
}
