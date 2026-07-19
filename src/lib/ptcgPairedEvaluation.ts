import fs from 'node:fs';
import path from 'node:path';

export const PAIRED_SCHEMA_VERSION = 'ptcg-paired-evaluation/v1' as const;

export interface SeatAgent {
  tactic: string;
  deckId: string;
}

export interface PairedCandidate {
  id: string;
  agent: SeatAgent;
}

export interface PairedMatch {
  candidateId: string;
  pairIndex: number;
  seed: number;
  orientation: 0 | 1;
  seat0: SeatAgent;
  seat1: SeatAgent;
}

export type PairedOutcome = 'candidate' | 'baseline' | 'draw';
export type FailureKind = 'fault' | 'timeout';

export interface PairedResult {
  candidateId: string;
  pairIndex: number;
  seed: number;
  orientation: 0 | 1;
  outcome: PairedOutcome;
  failure?: FailureKind;
  failedSide?: 'candidate' | 'baseline';
}

export interface PairedCandidateReport {
  candidateId: string;
  agent: SeatAgent;
  pairs: number;
  games: number;
  candidateWins: number;
  baselineWins: number;
  draws: number;
  winRateDifference: number;
  confidence95: { low: number; high: number };
  faults: { candidate: number; baseline: number };
  timeouts: { candidate: number; baseline: number };
}

export interface PairedEvaluationReport {
  schemaVersion: typeof PAIRED_SCHEMA_VERSION;
  baseline: SeatAgent;
  candidates: PairedCandidateReport[];
}

/** Every seed is reused once with each seat orientation, isolating seat advantage. */
export function buildPairedPlan(
  baseline: SeatAgent,
  candidates: readonly PairedCandidate[],
  pairs: number,
  baseSeed: number
): PairedMatch[] {
  if (!Number.isInteger(pairs) || pairs < 1) throw new Error('pairs must be a positive integer');
  if (!Number.isInteger(baseSeed)) throw new Error('baseSeed must be an integer');
  const plan: PairedMatch[] = [];
  for (const candidate of candidates) {
    if (candidate.agent.tactic === baseline.tactic && candidate.agent.deckId === baseline.deckId) {
      // Self-comparison is valid and intentionally retained as a calibration/control.
    }
    for (let pairIndex = 0; pairIndex < pairs; pairIndex++) {
      const seed = baseSeed + pairIndex;
      plan.push({
        candidateId: candidate.id,
        pairIndex,
        seed,
        orientation: 0,
        seat0: candidate.agent,
        seat1: baseline,
      });
      plan.push({
        candidateId: candidate.id,
        pairIndex,
        seed,
        orientation: 1,
        seat0: baseline,
        seat1: candidate.agent,
      });
    }
  }
  return plan;
}

/**
 * Cluster by (candidate, seed/pair) before computing uncertainty. Each cluster is the mean of the two
 * seat-swapped outcomes (+1 candidate win, -1 baseline win, 0 draw), so deck/tactic comparisons do not
 * pretend the two matched games are independent observations.
 */
export function evaluatePaired(
  baseline: SeatAgent,
  candidates: readonly PairedCandidate[],
  results: readonly PairedResult[]
): PairedEvaluationReport {
  const reports = candidates.map((candidate): PairedCandidateReport => {
    const rows = results.filter((r) => r.candidateId === candidate.id);
    const byPair = new Map<string, PairedResult[]>();
    for (const row of rows) {
      const key = `${row.pairIndex}:${row.seed}`;
      const bucket = byPair.get(key) ?? [];
      bucket.push(row);
      byPair.set(key, bucket);
    }
    for (const [key, pair] of byPair) {
      if (pair.length !== 2 || new Set(pair.map((r) => r.orientation)).size !== 2) {
        throw new Error(
          `${candidate.id} pair ${key} must contain both seat orientations exactly once`
        );
      }
    }
    const values = [...byPair.values()].map(
      (pair) =>
        pair.reduce(
          (sum, r) => sum + (r.outcome === 'candidate' ? 1 : r.outcome === 'baseline' ? -1 : 0),
          0
        ) / 2
    );
    const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    const variance =
      values.length > 1
        ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
        : 0;
    const margin = values.length > 1 ? 1.96 * Math.sqrt(variance / values.length) : 0;
    const failureCount = (kind: FailureKind, side: 'candidate' | 'baseline') =>
      rows.filter((r) => r.failure === kind && r.failedSide === side).length;
    return {
      candidateId: candidate.id,
      agent: candidate.agent,
      pairs: values.length,
      games: rows.length,
      candidateWins: rows.filter((r) => r.outcome === 'candidate').length,
      baselineWins: rows.filter((r) => r.outcome === 'baseline').length,
      draws: rows.filter((r) => r.outcome === 'draw').length,
      winRateDifference: mean,
      confidence95: { low: Math.max(-1, mean - margin), high: Math.min(1, mean + margin) },
      faults: {
        candidate: failureCount('fault', 'candidate'),
        baseline: failureCount('fault', 'baseline'),
      },
      timeouts: {
        candidate: failureCount('timeout', 'candidate'),
        baseline: failureCount('timeout', 'baseline'),
      },
    };
  });
  return { schemaVersion: PAIRED_SCHEMA_VERSION, baseline, candidates: reports };
}

export function pairedReportMarkdown(report: PairedEvaluationReport): string {
  const lines = [
    '# Paired deck/tactic evaluation',
    '',
    `Baseline: \`${report.baseline.tactic}:${report.baseline.deckId}\``,
    '',
    '| candidate | tactic:deck | pairs | games | win-rate diff | 95% CI | fault (C/B) | timeout (C/B) |',
    '| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |',
  ];
  for (const r of report.candidates) {
    lines.push(
      `| ${r.candidateId} | ${r.agent.tactic}:${r.agent.deckId} | ${r.pairs} | ${r.games} | ${r.winRateDifference.toFixed(4)} | [${r.confidence95.low.toFixed(4)}, ${r.confidence95.high.toFixed(4)}] | ${r.faults.candidate}/${r.faults.baseline} | ${r.timeouts.candidate}/${r.timeouts.baseline} |`
    );
  }
  return `${lines.join('\n')}\n`;
}

export function writePairedReports(
  dir: string,
  runId: string,
  report: PairedEvaluationReport
): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `paired.${runId}.json`), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, `paired.${runId}.md`), pairedReportMarkdown(report));
}
