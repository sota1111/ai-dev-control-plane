import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregateLeague, createLeagueCheckpoint, resumeLeague } from '../lib/ptcgLeagueReport.js';
import {
  budgetedMatchCount,
  buildRepresentativeRuntimePlan,
  buildRuntimeAudit,
  parseRuntimeLeagueManifest,
} from '../lib/ptcgRealRuntimeLeague.js';

describe('real runtime seven-agent audit', () => {
  it('plans every unordered matchup with fixed seeds and reversed seats', () => {
    const plans = buildRepresentativeRuntimePlan([7, 8]);
    expect(plans).toHaveLength(84);
    expect(plans.filter((plan) => plan.seed === 7)).toHaveLength(42);
    expect(plans.find((plan) => plan.id === 'sol-vs-zero.seed-7.ab')).toMatchObject({
      first: 'sol',
      second: 'zero',
    });
    expect(plans.find((plan) => plan.id === 'sol-vs-zero.seed-7.ba')).toMatchObject({
      first: 'zero',
      second: 'sol',
    });
  });

  it('uses the budget and prioritizes representative pairs without splitting seat swaps', () => {
    const manifest = parseRuntimeLeagueManifest({
      schemaVersion: 'ptcg-real-runtime-league-plan/v1',
      leagueId: 'stable',
      seeds: [7, 8, 9],
      seatSwap: true,
      timeoutMs: 10,
      budgetHours: 1,
      estimatedMatchMinutes: 5,
      priorityMatchups: [['sol', 'zero']],
    });
    expect(budgetedMatchCount(manifest)).toBe(12);
    const plans = buildRepresentativeRuntimePlan(manifest.seeds, {
      priorityMatchups: manifest.priorityMatchups,
      maxMatches: budgetedMatchCount(manifest),
    });
    expect(plans).toHaveLength(12);
    expect(plans.slice(0, 2).map((plan) => plan.id)).toEqual([
      'sol-vs-zero.seed-7.ab',
      'sol-vs-zero.seed-7.ba',
    ]);
    expect(
      plans.every((plan, index) => index % 2 === 0 || plan.seed === plans[index - 1].seed)
    ).toBe(true);
  });

  it('resumes a multi-seed plan with identical checkpoint bytes and aggregate', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-multi-seed-'));
    const checkpointFile = path.join(directory, 'checkpoint.json');
    const plans = buildRepresentativeRuntimePlan([7, 8]).slice(0, 8);
    let executions = 0;
    const run = async (matchId: string) => {
      executions++;
      const plan = plans.find((candidate) => candidate.id === matchId)!;
      return { matchId, first: plan.first, second: plan.second, outcome: 'first' as const };
    };
    const initial = await resumeLeague(
      checkpointFile,
      'stable',
      plans.map((plan) => plan.id),
      run
    );
    const initialBytes = fs.readFileSync(checkpointFile, 'utf8');
    const initialReport = aggregateLeague(initial);
    const resumed = await resumeLeague(
      checkpointFile,
      'stable',
      plans.map((plan) => plan.id),
      run
    );
    expect(executions).toBe(plans.length);
    expect(fs.readFileSync(checkpointFile, 'utf8')).toBe(initialBytes);
    expect(aggregateLeague(resumed)).toEqual(initialReport);
  });

  it('quantifies the synthetic/runtime delta and largest bottleneck', () => {
    const checkpoint = createLeagueCheckpoint('runtime', ['a', 'b']);
    checkpoint.events = [
      { matchId: 'a', first: 'sol', second: 'zero', outcome: 'first' },
      { matchId: 'b', first: 'zero', second: 'sol', outcome: 'second' },
    ];
    const runtime = aggregateLeague(checkpoint);
    const synthetic = {
      ...runtime,
      matchups: runtime.matchups.map((row) => ({ ...row, firstWinRate: 0.25 })),
    };
    const audit = buildRuntimeAudit({
      runtime,
      synthetic,
      seeds: [7],
      timeoutMs: 10,
      budgetHours: 8,
      elapsedMs: 1,
      events: checkpoint.events,
    });
    expect(audit.bottleneck).toEqual({ matchup: 'sol vs zero', absoluteDelta: 0.75 });
    expect(audit.execution).toMatchObject({
      faults: 0,
      unfinished: 0,
      illegalActions: 0,
      timeouts: 0,
    });
    expect(audit.syntheticDifference[0]).toMatchObject({
      sampleSize: 2,
      runtimeWilson95: expect.objectContaining({
        low: expect.any(Number),
        high: expect.any(Number),
      }),
      deltaWilson95: expect.objectContaining({
        low: expect.any(Number),
        high: expect.any(Number),
      }),
    });
  });
});
