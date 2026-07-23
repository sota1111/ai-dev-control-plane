import { createLeagueCheckpoint, type LeagueReport } from '../lib/ptcgLeagueReport.js';
import { buildSyntheticCalibration } from '../lib/ptcgSyntheticCalibration.js';

describe('synthetic/runtime calibration', () => {
  it('fits only training seeds and reports holdout improvement and matchup hypotheses', () => {
    const checkpoint = createLeagueCheckpoint('runtime', []);
    checkpoint.events = [1, 2, 3].flatMap((seed) => [
      { matchId: `a-vs-b.seed-${seed}.ab`, first: 'a', second: 'b', outcome: 'first' as const },
      { matchId: `a-vs-b.seed-${seed}.ba`, first: 'b', second: 'a', outcome: 'second' as const },
      { matchId: `a-vs-c.seed-${seed}.ab`, first: 'a', second: 'c', outcome: 'first' as const },
      { matchId: `a-vs-c.seed-${seed}.ba`, first: 'c', second: 'a', outcome: 'second' as const },
    ]);
    const synthetic = {
      matchups: [
        { first: 'a', second: 'b', firstWinRate: 0.5 },
        { first: 'a', second: 'c', firstWinRate: 0.5 },
      ],
    } as LeagueReport;
    const report = buildSyntheticCalibration({
      checkpoint,
      synthetic,
      syntheticPath: 'synthetic.json',
      checkpointPath: 'runtime.json',
    });
    expect(report.split).toMatchObject({
      trainingSeeds: [1, 2],
      holdoutSeeds: [3],
      trainingEvents: 8,
      holdoutEvents: 4,
    });
    expect(report.holdout.after.mae).toBeLessThan(report.holdout.before.mae);
    expect(report.holdout.improved).toBe(true);
    expect(report.matchupAnalysis).toHaveLength(2);
    expect(report.matchupAnalysis.every((row) => row.factorHypothesis.length > 20)).toBe(true);
    expect(report.reinforcementPriority.map((row) => row.rank)).toEqual([1, 2, 3]);
  });
});
