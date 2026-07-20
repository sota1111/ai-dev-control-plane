import {
  LEAGUE_SCHEDULER_STATE_SCHEMA,
  LeagueScheduler,
  type LeagueMember,
  type LeaguePolicy,
} from '../lib/ptcgLeagueScheduler.js';

const policy: LeaguePolicy = {
  seed: 1775,
  curriculum: [
    { id: 'stage.basic', minimumMatches: 2, minimumWinRate: 0.5 },
    { id: 'stage.advanced', minimumMatches: 2, minimumWinRate: 0.75 },
  ],
  matchmaking: {
    main: { main: 1, exploiter: 3 },
    exploiter: { main: 2 },
    explorer: { main: 1, exploiter: 1 },
  },
  snapshotPromotion: { minimumMatches: 2, minimumWinRate: 0.5 },
};

const members: LeagueMember[] = [
  { id: 'agent.main', role: 'main', snapshotId: 'model.main.1', generation: 1, active: true },
  {
    id: 'agent.exploiter',
    role: 'exploiter',
    snapshotId: 'model.exploiter.1',
    generation: 1,
    active: true,
  },
  {
    id: 'agent.explorer',
    role: 'explorer',
    snapshotId: 'model.explorer.1',
    generation: 1,
    active: true,
  },
];

describe('LeagueScheduler', () => {
  it('validates configurable curriculum conditions and promotes only after the fixture passes', () => {
    const scheduler = new LeagueScheduler(policy, members);
    const first = scheduler.schedule('agent.main');
    scheduler.complete(first.matchId, 'agent.main');
    expect(scheduler.currentStage().id).toBe('stage.basic');
    const second = scheduler.schedule('agent.main');
    scheduler.complete(second.matchId, 'agent.main');
    expect(scheduler.currentStage().id).toBe('stage.advanced');
    expect(scheduler.snapshot().curriculumHistory).toEqual([
      { from: 'stage.basic', to: 'stage.advanced', afterMatchId: second.matchId },
    ]);
    expect(scheduler.snapshot().promotedSnapshots).toEqual(['model.main.1']);
  });

  it('reproduces role-weighted matchmaking from policy, seed, and state', () => {
    const a = new LeagueScheduler(policy, members);
    const b = new LeagueScheduler(policy, [...members].reverse());
    const scheduleA = Array.from({ length: 5 }, () => a.schedule('agent.main'));
    const scheduleB = Array.from({ length: 5 }, () => b.schedule('agent.main'));
    expect(scheduleA).toEqual(scheduleB);
    expect(scheduleA.every((match) => match.opponentId !== 'agent.explorer')).toBe(true);
    expect(scheduleA.some((match) => match.opponentId === 'agent.exploiter')).toBe(true);
  });

  it('records exploit/explore events and updates auditable model lineage', () => {
    const scheduler = new LeagueScheduler(policy, members);
    const event = scheduler.exploitExplore({
      sourceMemberId: 'agent.main',
      targetMemberId: 'agent.explorer',
      childSnapshotId: 'model.explorer.2',
      mutations: { learningRateScale: 1.1, entropyScale: 0.9 },
    });
    expect(event).toMatchObject({
      parentSnapshotId: 'model.main.1',
      childSnapshotId: 'model.explorer.2',
      sourceMemberId: 'agent.main',
      targetMemberId: 'agent.explorer',
    });
    expect(
      scheduler.snapshot().members.find((member) => member.id === 'agent.explorer')
    ).toMatchObject({ snapshotId: 'model.explorer.2', generation: 2 });
  });

  it('finishes a small league identically across interruption and resume', () => {
    const uninterrupted = new LeagueScheduler(policy, members);
    const interrupted = new LeagueScheduler(policy, members);
    const run = (scheduler: LeagueScheduler, count: number): void => {
      for (let index = 0; index < count; index += 1) {
        const match = scheduler.schedule('agent.main');
        scheduler.complete(
          match.matchId,
          match.sequence % 2 === 0 ? 'agent.main' : match.opponentId
        );
      }
    };
    run(uninterrupted, 2);
    run(interrupted, 1);
    const checkpoint = interrupted.snapshot();
    expect(checkpoint.schemaVersion).toBe(LEAGUE_SCHEDULER_STATE_SCHEMA);
    const resumed = new LeagueScheduler(policy, checkpoint.members, checkpoint);
    run(resumed, 1);
    expect(resumed.snapshot()).toEqual(uninterrupted.snapshot());
  });

  it('rejects resume with a changed policy', () => {
    const scheduler = new LeagueScheduler(policy, members);
    expect(
      () => new LeagueScheduler({ ...policy, seed: policy.seed + 1 }, members, scheduler.snapshot())
    ).toThrow('policy does not match');
  });
});
