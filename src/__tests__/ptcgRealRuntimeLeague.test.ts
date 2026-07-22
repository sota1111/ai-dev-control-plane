import { aggregateLeague, createLeagueCheckpoint } from '../lib/ptcgLeagueReport.js';
import { buildRepresentativeRuntimePlan, buildRuntimeAudit } from '../lib/ptcgRealRuntimeLeague.js';

describe('real runtime seven-agent audit', () => {
  it('plans every unordered matchup with fixed seeds and reversed seats', () => {
    const plans = buildRepresentativeRuntimePlan([7, 8]);
    expect(plans).toHaveLength(84);
    expect(plans.filter((plan) => plan.seed === 7)).toHaveLength(42);
    expect(plans.find((plan) => plan.id === 'sol-vs-zero.seed-7.ab')).toMatchObject({ first: 'sol', second: 'zero' });
    expect(plans.find((plan) => plan.id === 'sol-vs-zero.seed-7.ba')).toMatchObject({ first: 'zero', second: 'sol' });
  });

  it('quantifies the synthetic/runtime delta and largest bottleneck', () => {
    const checkpoint = createLeagueCheckpoint('runtime', ['a', 'b']);
    checkpoint.events = [
      { matchId: 'a', first: 'sol', second: 'zero', outcome: 'first' },
      { matchId: 'b', first: 'zero', second: 'sol', outcome: 'second' },
    ];
    const runtime = aggregateLeague(checkpoint);
    const synthetic = { ...runtime, matchups: runtime.matchups.map((row) => ({ ...row, firstWinRate: 0.25 })) };
    const audit = buildRuntimeAudit({ runtime, synthetic, seeds: [7], timeoutMs: 10, budgetHours: 8, elapsedMs: 1, events: checkpoint.events });
    expect(audit.bottleneck).toEqual({ matchup: 'sol vs zero', absoluteDelta: 0.75 });
    expect(audit.execution).toMatchObject({ faults: 0, unfinished: 0, illegalActions: 0, timeouts: 0 });
  });
});
