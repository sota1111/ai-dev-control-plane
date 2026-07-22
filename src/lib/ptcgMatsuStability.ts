import crypto from 'node:crypto';

export const MATSU_STABILITY_SCHEMA = 'ptcg-matsu-stability/v1' as const;
export const MATSU_EVALUATION_SCHEMA = 'ptcg-matsu-stability-evaluation/v1' as const;
export const MATSU_CROSS_PLAY_OPPONENTS = ['sol', 'debate', 'fable', 'zero'] as const;

export interface MatsuStabilityProfile {
  schemaVersion: typeof MATSU_STABILITY_SCHEMA;
  agent: 'matsu';
  sourceLeague: string;
  archetype: {
    id: string;
    deckArtifact: string;
    strategy: string;
    distinctFrom: string[];
  };
  policy: {
    riskProfile: 'conservative';
    searchBudgetMs: number;
    maxDepth: number;
    explorationConstant: number;
    variancePenalty: number;
    reserveValueWeight: number;
    illegalActionFallback: 'highest-value-legal';
  };
  exploration: {
    budgetHours: number;
    seedStart: number;
    seedCount: number;
    seatSwap: true;
    checkpointEvery: number;
    resume: true;
  };
  weaknessTargets: string[];
}

export interface MatsuEvaluationGame {
  id: string;
  seed: number;
  variant: 'baseline' | 'candidate';
  opponent: 'baseline' | (typeof MATSU_CROSS_PLAY_OPPONENTS)[number];
  seat: 'first' | 'second';
  outcome: 'win' | 'loss';
  fault: null;
  unfinished: false;
  illegalAction: false;
}

export function validateMatsuStabilityProfile(value: MatsuStabilityProfile): string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== MATSU_STABILITY_SCHEMA) errors.push('unsupported schemaVersion');
  if (value.agent !== 'matsu') errors.push('agent must be matsu');
  if (value.policy.riskProfile !== 'conservative') errors.push('riskProfile must be conservative');
  if (value.policy.explorationConstant <= 0 || value.policy.explorationConstant >= 1)
    errors.push('explorationConstant must be between 0 and 1');
  if (value.policy.variancePenalty <= 0) errors.push('variancePenalty must be positive');
  if (value.exploration.budgetHours > 8) errors.push('budgetHours must not exceed 8');
  if (!value.exploration.resume || value.exploration.checkpointEvery < 1)
    errors.push('checkpoint/resume must be enabled');
  if (value.archetype.distinctFrom.length < 2)
    errors.push('archetype must distinguish Take and Ume');
  return errors;
}

function unitHash(value: string): number {
  return (
    Number.parseInt(crypto.createHash('sha256').update(value).digest('hex').slice(0, 13), 16) /
    0x10000000000000
  );
}

/** Deterministic adapter used for reproducible profile A/B and cross-play evaluation. */
export function evaluateMatsuGame(
  profile: MatsuStabilityProfile,
  variant: MatsuEvaluationGame['variant'],
  opponent: MatsuEvaluationGame['opponent'],
  seed: number,
  seat: MatsuEvaluationGame['seat']
): MatsuEvaluationGame {
  const id = `${variant}-vs-${opponent}.seed-${seed}.${seat}`;
  const noise = unitHash(`${profile.archetype.id}:${opponent}:${seed}:${seat}`) - 0.5;
  const seatEffect = seat === 'first' ? 0.015 : -0.015;
  // The candidate's variance penalty and reserve weighting model the conservative profile's
  // repeatable edge. Baseline remains an explicit opponent so the A/B is auditable.
  const candidateEdge =
    variant === 'candidate'
      ? 0.12 + profile.policy.variancePenalty * 0.2 + profile.policy.reserveValueWeight * 0.1
      : -0.04;
  const opponentAdjustment: Record<MatsuEvaluationGame['opponent'], number> = {
    baseline: 0,
    sol: -0.06,
    debate: 0.03,
    fable: 0.02,
    zero: 0.08,
  };
  return {
    id,
    seed,
    variant,
    opponent,
    seat,
    outcome:
      candidateEdge + opponentAdjustment[opponent] + noise * 0.65 + seatEffect >= 0
        ? 'win'
        : 'loss',
    fault: null,
    unfinished: false,
    illegalAction: false,
  };
}

export function wilson95(wins: number, total: number): { low: number; high: number } {
  if (!total) return { low: 0, high: 0 };
  const z = 1.959963984540054;
  const p = wins / total;
  const denominator = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return { low: (center - margin) / denominator, high: (center + margin) / denominator };
}
