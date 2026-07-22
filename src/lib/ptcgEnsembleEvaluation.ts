export const ENSEMBLE_SCHEMA = 'ptcg-ensemble-evaluation/v1' as const;

export interface EnsembleConfig {
  schemaVersion: typeof ENSEMBLE_SCHEMA;
  agents: Array<{ id: string; profile: string; report: string; checkpoint: string }>;
  opponents: string[];
  nonRegression: { minimumMatchupWinRate: number; maximumBelowEnsembleMean: number };
  execution: {
    seedCountPerAgent: number;
    seatSwap: true;
    budgetHours: number;
    resumeRequired: true;
  };
}

interface Profile {
  agent: string;
  archetype: { deckArtifact: string; strategy: string };
  policy: { riskProfile: string; maxDepth: number; explorationConstant: number };
  exploration: { seedCount: number; seatSwap: boolean; budgetHours: number; resume: boolean };
}

interface EvaluationReport {
  results: Array<{
    variant: string;
    opponent: string;
    games: number;
    wins: number;
    losses: number;
    winRate: number;
  }>;
  safety: { faults: number; unfinished: number; illegalActions: number };
}

export interface EnsembleReport {
  schemaVersion: 'ptcg-ensemble-report/v1';
  diversity: {
    uniqueDecks: number;
    uniqueStrategies: number;
    uniqueRiskProfiles: number;
    pairwisePolicyDistance: Record<string, number>;
    meanPolicyDistance: number;
  };
  matchupMatrix: Record<string, Record<string, number>>;
  ensembleByOpponent: Record<
    string,
    { games: number; wins: number; winRate: number; belowMeanBy: number; regression: boolean }
  >;
  individualAB: Record<
    string,
    { baselineWinRate: number; candidateWinRate: number; delta: number }
  >;
  execution: {
    seedsPerAgent: number;
    seatSwap: boolean;
    totalCrossPlayGames: number;
    resumableCheckpoints: number;
    budgetHours: number;
  };
  safety: { faults: number; unfinished: number; illegalActions: number };
  verdict: { diverse: boolean; noMajorRegression: boolean; safe: boolean; pass: boolean };
}

const riskOrdinal: Record<string, number> = { conservative: 0, balanced: 0.5, aggressive: 1 };

function policyDistance(a: Profile, b: Profile): number {
  const risk = Math.abs(
    (riskOrdinal[a.policy.riskProfile] ?? 0) - (riskOrdinal[b.policy.riskProfile] ?? 0)
  );
  const depth = Math.min(1, Math.abs(a.policy.maxDepth - b.policy.maxDepth) / 2);
  const exploration = Math.min(
    1,
    Math.abs(a.policy.explorationConstant - b.policy.explorationConstant) / 0.83
  );
  return Number(((risk + depth + exploration) / 3).toFixed(3));
}

export function buildEnsembleReport(
  config: EnsembleConfig,
  inputs: Array<{ profile: Profile; report: EvaluationReport; checkpointResumable: boolean }>
): EnsembleReport {
  if (config.schemaVersion !== ENSEMBLE_SCHEMA) throw new Error('unsupported ensemble schema');
  if (inputs.length !== 3 || config.agents.length !== 3)
    throw new Error('exactly three agents are required');
  const profiles = inputs.map((input) => input.profile);
  const pairwisePolicyDistance: Record<string, number> = {};
  for (let left = 0; left < profiles.length; left += 1) {
    for (let right = left + 1; right < profiles.length; right += 1) {
      pairwisePolicyDistance[`${profiles[left].agent}-${profiles[right].agent}`] = policyDistance(
        profiles[left],
        profiles[right]
      );
    }
  }
  const distances = Object.values(pairwisePolicyDistance);
  const matchupMatrix: Record<string, Record<string, number>> = {};
  const individualAB: EnsembleReport['individualAB'] = {};
  const safety = { faults: 0, unfinished: 0, illegalActions: 0 };
  let totalCrossPlayGames = 0;
  for (const { profile, report } of inputs) {
    const candidate = report.results.filter((row) => row.variant === 'candidate');
    matchupMatrix[profile.agent] = Object.fromEntries(
      config.opponents.map((opponent) => {
        const row = candidate.find((result) => result.opponent === opponent);
        if (!row || row.games !== config.execution.seedCountPerAgent * 2)
          throw new Error(`${profile.agent}/${opponent} is incomplete`);
        totalCrossPlayGames += row.games;
        return [opponent, row.winRate];
      })
    );
    const baseline = report.results.find(
      (row) => row.variant === 'baseline' && row.opponent === 'baseline'
    );
    const upgraded = candidate.find((row) => row.opponent === 'baseline');
    if (!baseline || !upgraded) throw new Error(`${profile.agent} A/B result is missing`);
    individualAB[profile.agent] = {
      baselineWinRate: baseline.winRate,
      candidateWinRate: upgraded.winRate,
      delta: Number((upgraded.winRate - baseline.winRate).toFixed(3)),
    };
    safety.faults += report.safety.faults;
    safety.unfinished += report.safety.unfinished;
    safety.illegalActions += report.safety.illegalActions;
  }
  const opponentRates = config.opponents.map((opponent) => {
    const rows = inputs.map(
      ({ profile, report }) =>
        report.results.find((row) => row.variant === 'candidate' && row.opponent === opponent)!
    );
    const games = rows.reduce((sum, row) => sum + row.games, 0);
    const wins = rows.reduce((sum, row) => sum + row.wins, 0);
    return { opponent, games, wins, winRate: wins / games };
  });
  const ensembleMean =
    opponentRates.reduce((sum, row) => sum + row.winRate, 0) / opponentRates.length;
  const ensembleByOpponent = Object.fromEntries(
    opponentRates.map((row) => {
      const belowMeanBy = Math.max(0, ensembleMean - row.winRate);
      const regression =
        row.winRate < config.nonRegression.minimumMatchupWinRate ||
        belowMeanBy > config.nonRegression.maximumBelowEnsembleMean;
      return [
        row.opponent,
        {
          games: row.games,
          wins: row.wins,
          winRate: Number(row.winRate.toFixed(3)),
          belowMeanBy: Number(belowMeanBy.toFixed(3)),
          regression,
        },
      ];
    })
  );
  const diversity = {
    uniqueDecks: new Set(profiles.map((profile) => profile.archetype.deckArtifact)).size,
    uniqueStrategies: new Set(profiles.map((profile) => profile.archetype.strategy)).size,
    uniqueRiskProfiles: new Set(profiles.map((profile) => profile.policy.riskProfile)).size,
    pairwisePolicyDistance,
    meanPolicyDistance: Number(
      (distances.reduce((sum, value) => sum + value, 0) / distances.length).toFixed(3)
    ),
  };
  const resumableCheckpoints = inputs.filter((input) => input.checkpointResumable).length;
  const diverse =
    diversity.uniqueDecks === 3 &&
    diversity.uniqueStrategies === 3 &&
    diversity.uniqueRiskProfiles === 3 &&
    distances.every((value) => value > 0);
  const noMajorRegression =
    Object.values(ensembleByOpponent).every((row) => !row.regression) &&
    Object.values(individualAB).every((row) => row.delta > 0);
  const safe = safety.faults === 0 && safety.unfinished === 0 && safety.illegalActions === 0;
  const executionValid =
    profiles.every(
      (profile) =>
        profile.exploration.seedCount >= config.execution.seedCountPerAgent &&
        profile.exploration.seatSwap &&
        profile.exploration.resume &&
        profile.exploration.budgetHours <= config.execution.budgetHours
    ) && resumableCheckpoints === 3;
  return {
    schemaVersion: 'ptcg-ensemble-report/v1',
    diversity,
    matchupMatrix,
    ensembleByOpponent,
    individualAB,
    execution: {
      seedsPerAgent: config.execution.seedCountPerAgent,
      seatSwap: config.execution.seatSwap,
      totalCrossPlayGames,
      resumableCheckpoints,
      budgetHours: config.execution.budgetHours,
    },
    safety,
    verdict: {
      diverse,
      noMajorRegression,
      safe,
      pass: diverse && noMajorRegression && safe && executionValid,
    },
  };
}
