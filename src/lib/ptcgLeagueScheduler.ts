import crypto from 'node:crypto';

export const LEAGUE_SCHEDULER_STATE_SCHEMA = 'ptcg-league-scheduler-state/v1' as const;

export type LeagueRole = 'main' | 'exploiter' | 'explorer';

export interface CurriculumStage {
  id: string;
  minimumMatches: number;
  minimumWinRate: number;
}

export interface LeagueMember {
  id: string;
  role: LeagueRole;
  snapshotId: string;
  generation: number;
  active: boolean;
}

export interface LeaguePolicy {
  seed: number;
  curriculum: CurriculumStage[];
  matchmaking: Record<LeagueRole, Partial<Record<LeagueRole, number>>>;
  snapshotPromotion: { minimumMatches: number; minimumWinRate: number };
}

export interface ScheduledLeagueMatch {
  matchId: string;
  sequence: number;
  seed: number;
  stageId: string;
  learnerId: string;
  opponentId: string;
}

export interface PbtEvent {
  eventId: string;
  sequence: number;
  sourceMemberId: string;
  targetMemberId: string;
  parentSnapshotId: string;
  childSnapshotId: string;
  mutations: Record<string, number>;
}

export interface LeagueSchedulerState {
  schemaVersion: typeof LEAGUE_SCHEDULER_STATE_SCHEMA;
  policyHash: string;
  stageIndex: number;
  stageMatches: number;
  stageWins: number;
  nextSequence: number;
  members: LeagueMember[];
  scheduled: ScheduledLeagueMatch[];
  completedMatches: Array<{ matchId: string; winnerId: string | null }>;
  curriculumHistory: Array<{ from: string; to: string; afterMatchId: string }>;
  promotedSnapshots: string[];
  pbtEvents: PbtEvent[];
}

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stableUint32(value: string): number {
  return Number.parseInt(crypto.createHash('sha256').update(value).digest('hex').slice(0, 8), 16);
}

function assertId(value: string, name: string): void {
  if (!ID_RE.test(value)) throw new Error(`${name} must be a stable lowercase id`);
}

function validatePolicy(policy: LeaguePolicy): void {
  if (!Number.isSafeInteger(policy.seed) || policy.seed < 0)
    throw new Error('policy seed must be a non-negative safe integer');
  if (policy.curriculum.length === 0) throw new Error('curriculum must contain a stage');
  const ids = new Set<string>();
  policy.curriculum.forEach((stage) => {
    assertId(stage.id, 'curriculum stage id');
    if (ids.has(stage.id)) throw new Error(`duplicate curriculum stage ${stage.id}`);
    ids.add(stage.id);
    if (!Number.isSafeInteger(stage.minimumMatches) || stage.minimumMatches < 1)
      throw new Error('minimumMatches must be positive');
    if (stage.minimumWinRate < 0 || stage.minimumWinRate > 1)
      throw new Error('minimumWinRate must be between 0 and 1');
  });
  for (const role of ['main', 'exploiter', 'explorer'] as const) {
    const weights = policy.matchmaking[role];
    if (
      !weights ||
      Object.values(weights).some((weight) => !Number.isFinite(weight) || weight! < 0)
    )
      throw new Error(`matchmaking weights for ${role} are invalid`);
  }
  if (
    !Number.isSafeInteger(policy.snapshotPromotion.minimumMatches) ||
    policy.snapshotPromotion.minimumMatches < 1 ||
    policy.snapshotPromotion.minimumWinRate < 0 ||
    policy.snapshotPromotion.minimumWinRate > 1
  )
    throw new Error('snapshot promotion condition is invalid');
}

function initialState(policy: LeaguePolicy, members: LeagueMember[]): LeagueSchedulerState {
  const ids = new Set<string>();
  members.forEach((member) => {
    assertId(member.id, 'member id');
    assertId(member.snapshotId, 'snapshot id');
    if (ids.has(member.id)) throw new Error(`duplicate member ${member.id}`);
    ids.add(member.id);
    if (!Number.isSafeInteger(member.generation) || member.generation < 0)
      throw new Error('member generation must be non-negative');
  });
  return {
    schemaVersion: LEAGUE_SCHEDULER_STATE_SCHEMA,
    policyHash: stableHash(policy),
    stageIndex: 0,
    stageMatches: 0,
    stageWins: 0,
    nextSequence: 0,
    members: structuredClone(members),
    scheduled: [],
    completedMatches: [],
    curriculumHistory: [],
    promotedSnapshots: [],
    pbtEvents: [],
  };
}

/** Deterministic curriculum, role matchmaking, snapshot promotion, and PBT event scheduler. */
export class LeagueScheduler {
  private readonly state: LeagueSchedulerState;

  constructor(
    private readonly policy: LeaguePolicy,
    members: LeagueMember[],
    restored?: LeagueSchedulerState
  ) {
    validatePolicy(policy);
    const candidate = restored ? structuredClone(restored) : initialState(policy, members);
    if (candidate.schemaVersion !== LEAGUE_SCHEDULER_STATE_SCHEMA)
      throw new Error('unsupported league scheduler state schema');
    if (candidate.policyHash !== stableHash(policy)) throw new Error('state policy does not match');
    if (restored && stableHash(candidate.members) !== stableHash(members))
      throw new Error('state members do not match');
    if (candidate.stageIndex < 0 || candidate.stageIndex >= policy.curriculum.length)
      throw new Error('state curriculum stage is out of range');
    this.state = candidate;
  }

  currentStage(): CurriculumStage {
    return structuredClone(this.policy.curriculum[this.state.stageIndex]);
  }

  schedule(learnerId: string): ScheduledLeagueMatch {
    const learner = this.state.members.find((member) => member.id === learnerId && member.active);
    if (!learner) throw new Error(`unknown active learner ${learnerId}`);
    const candidates = this.state.members
      .filter((member) => member.active && member.id !== learner.id)
      .sort((a, b) => a.id.localeCompare(b.id));
    const weighted = candidates.flatMap((candidate) => {
      const weight = this.policy.matchmaking[learner.role][candidate.role] ?? 0;
      return Array.from({ length: Math.floor(weight) }, () => candidate);
    });
    if (weighted.length === 0) throw new Error(`no eligible opponent for ${learnerId}`);
    const sequence = this.state.nextSequence++;
    const seed = stableUint32(`${this.policy.seed}:${sequence}:${learnerId}`);
    const opponent = weighted[seed % weighted.length];
    const match: ScheduledLeagueMatch = {
      matchId: `league.match.${String(sequence).padStart(8, '0')}`,
      sequence,
      seed,
      stageId: this.currentStage().id,
      learnerId,
      opponentId: opponent.id,
    };
    this.state.scheduled.push(match);
    return structuredClone(match);
  }

  complete(matchId: string, winnerId: string | null): void {
    const match = this.state.scheduled.find((item) => item.matchId === matchId);
    if (!match) throw new Error(`unknown scheduled match ${matchId}`);
    if (this.state.completedMatches.some((item) => item.matchId === matchId))
      throw new Error(`match ${matchId} completed`);
    if (winnerId !== null && winnerId !== match.learnerId && winnerId !== match.opponentId)
      throw new Error('winner must be a contestant or null');
    this.state.completedMatches.push({ matchId, winnerId });
    this.state.stageMatches += 1;
    if (winnerId === match.learnerId) this.state.stageWins += 1;
    const stage = this.policy.curriculum[this.state.stageIndex];
    if (
      this.state.stageIndex < this.policy.curriculum.length - 1 &&
      this.state.stageMatches >= stage.minimumMatches &&
      this.state.stageWins / this.state.stageMatches >= stage.minimumWinRate
    ) {
      const next = this.policy.curriculum[++this.state.stageIndex];
      this.state.curriculumHistory.push({ from: stage.id, to: next.id, afterMatchId: matchId });
      this.state.stageMatches = 0;
      this.state.stageWins = 0;
    }
    const learnerMatches = this.state.scheduled.filter(
      (item) =>
        item.learnerId === match.learnerId &&
        this.state.completedMatches.some((result) => result.matchId === item.matchId)
    );
    const learnerWins = learnerMatches.filter((item) =>
      this.state.completedMatches.some(
        (result) => result.matchId === item.matchId && result.winnerId === item.learnerId
      )
    ).length;
    if (
      learnerMatches.length >= this.policy.snapshotPromotion.minimumMatches &&
      learnerWins / learnerMatches.length >= this.policy.snapshotPromotion.minimumWinRate
    ) {
      const snapshot = this.state.members.find(
        (member) => member.id === match.learnerId
      )!.snapshotId;
      if (!this.state.promotedSnapshots.includes(snapshot))
        this.state.promotedSnapshots.push(snapshot);
    }
  }

  exploitExplore(input: {
    sourceMemberId: string;
    targetMemberId: string;
    childSnapshotId: string;
    mutations: Record<string, number>;
  }): PbtEvent {
    const source = this.state.members.find((member) => member.id === input.sourceMemberId);
    const target = this.state.members.find((member) => member.id === input.targetMemberId);
    if (!source || !target || source.id === target.id)
      throw new Error('PBT members must be distinct');
    assertId(input.childSnapshotId, 'child snapshot id');
    if (this.state.members.some((member) => member.snapshotId === input.childSnapshotId))
      throw new Error(`snapshot ${input.childSnapshotId} already exists`);
    if (Object.values(input.mutations).some((value) => !Number.isFinite(value)))
      throw new Error('PBT mutations must be finite');
    const sequence = this.state.pbtEvents.length;
    const event: PbtEvent = {
      eventId: `pbt.event.${String(sequence).padStart(8, '0')}`,
      sequence,
      sourceMemberId: source.id,
      targetMemberId: target.id,
      parentSnapshotId: source.snapshotId,
      childSnapshotId: input.childSnapshotId,
      mutations: structuredClone(input.mutations),
    };
    target.snapshotId = input.childSnapshotId;
    target.generation = Math.max(target.generation, source.generation) + 1;
    this.state.pbtEvents.push(event);
    return structuredClone(event);
  }

  snapshot(): LeagueSchedulerState {
    return structuredClone(this.state);
  }
}
