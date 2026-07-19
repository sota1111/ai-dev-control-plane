import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPairedPlan,
  evaluatePaired,
  pairedReportMarkdown,
  writePairedReports,
  type PairedCandidate,
  type PairedResult,
} from '../lib/ptcgPairedEvaluation.js';

const baseline = { tactic: 'matsu', deckId: 'champion' };
const candidates: PairedCandidate[] = [
  { id: 'deck-only', agent: { tactic: 'matsu', deckId: 'challenger' } },
  { id: 'tactic-only', agent: { tactic: 'take', deckId: 'champion' } },
  { id: 'self', agent: baseline },
];

describe('paired deck/tactic evaluation', () => {
  it('specifies tactic and deck independently per seat and swaps seats with the same seed', () => {
    const plan = buildPairedPlan(baseline, candidates.slice(0, 2), 2, 41);
    expect(plan).toHaveLength(8);
    expect(plan.slice(0, 2)).toEqual([
      {
        candidateId: 'deck-only',
        pairIndex: 0,
        seed: 41,
        orientation: 0,
        seat0: candidates[0].agent,
        seat1: baseline,
      },
      {
        candidateId: 'deck-only',
        pairIndex: 0,
        seed: 41,
        orientation: 1,
        seat0: baseline,
        seat1: candidates[0].agent,
      },
    ]);
    expect(plan[4].seat0).toEqual({ tactic: 'take', deckId: 'champion' });
    expect(plan[4].seat1).toEqual(baseline);
  });

  it('aggregates paired seed/seat clusters and exposes faults and timeouts', () => {
    const results: PairedResult[] = [
      { candidateId: 'deck-only', pairIndex: 0, seed: 1, orientation: 0, outcome: 'candidate' },
      {
        candidateId: 'deck-only',
        pairIndex: 0,
        seed: 1,
        orientation: 1,
        outcome: 'candidate',
        failure: 'timeout',
        failedSide: 'baseline',
      },
      {
        candidateId: 'deck-only',
        pairIndex: 1,
        seed: 2,
        orientation: 0,
        outcome: 'baseline',
        failure: 'fault',
        failedSide: 'candidate',
      },
      { candidateId: 'deck-only', pairIndex: 1, seed: 2, orientation: 1, outcome: 'candidate' },
    ];
    const row = evaluatePaired(baseline, candidates.slice(0, 1), results).candidates[0];
    expect(row).toMatchObject({
      pairs: 2,
      games: 4,
      candidateWins: 3,
      baselineWins: 1,
      winRateDifference: 0.5,
    });
    expect(row.faults).toEqual({ candidate: 1, baseline: 0 });
    expect(row.timeouts).toEqual({ candidate: 0, baseline: 1 });
    expect(row.confidence95.low).toBeLessThan(row.winRateDifference);
  });

  it('baseline self-comparison is centered at zero and writes machine/human reports', () => {
    const results: PairedResult[] = [
      { candidateId: 'self', pairIndex: 0, seed: 9, orientation: 0, outcome: 'candidate' },
      { candidateId: 'self', pairIndex: 0, seed: 9, orientation: 1, outcome: 'baseline' },
    ];
    const report = evaluatePaired(baseline, candidates.slice(2), results);
    expect(report.candidates[0].winRateDifference).toBe(0);
    expect(report.candidates[0].confidence95).toEqual({ low: 0, high: 0 });
    expect(pairedReportMarkdown(report)).toContain('fault (C/B)');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-report-'));
    writePairedReports(dir, 'holdout', report);
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, 'paired.holdout.json'), 'utf8')).schemaVersion
    ).toBe('ptcg-paired-evaluation/v1');
    expect(fs.readFileSync(path.join(dir, 'paired.holdout.md'), 'utf8')).toContain(
      'matsu:champion'
    );
  });

  it('rejects an unpaired result instead of silently biasing the comparison', () => {
    expect(() =>
      evaluatePaired(baseline, candidates.slice(0, 1), [
        { candidateId: 'deck-only', pairIndex: 0, seed: 1, orientation: 0, outcome: 'candidate' },
      ])
    ).toThrow(/both seat orientations/);
  });
});
