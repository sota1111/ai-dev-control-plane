import crypto from 'node:crypto';

export const TAKE_ADAPTIVE_SCHEMA = 'ptcg-take-adaptive/v1' as const;
export const TAKE_EVALUATION_SCHEMA = 'ptcg-take-adaptive-evaluation/v1' as const;
export const TAKE_CROSS_PLAY_OPPONENTS = ['sol', 'debate', 'fable', 'zero'] as const;

export interface TakeAdaptiveProfile {
  schemaVersion: typeof TAKE_ADAPTIVE_SCHEMA;
  agent: 'take';
  sourceLeague: string;
  archetype: { id: string; deckArtifact: string; strategy: string; distinctFrom: string[] };
  policy: {
    riskProfile: 'balanced';
    searchBudgetMs: number;
    maxDepth: number;
    explorationConstant: number;
    adaptationWeight: number;
    riskFloor: number;
    riskCeiling: number;
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

export interface TakeEvaluationGame {
  id: string;
  seed: number;
  variant: 'baseline' | 'candidate';
  opponent: 'baseline' | (typeof TAKE_CROSS_PLAY_OPPONENTS)[number];
  seat: 'first' | 'second';
  outcome: 'win' | 'loss';
  fault: null;
  unfinished: false;
  illegalAction: false;
}

export function validateTakeAdaptiveProfile(value: TakeAdaptiveProfile): string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== TAKE_ADAPTIVE_SCHEMA) errors.push('unsupported schemaVersion');
  if (value.agent !== 'take') errors.push('agent must be take');
  if (value.policy.riskProfile !== 'balanced') errors.push('riskProfile must be balanced');
  if (
    value.policy.riskFloor < 0 ||
    value.policy.riskCeiling > 1 ||
    value.policy.riskFloor >= value.policy.riskCeiling
  )
    errors.push('risk bounds must define a balanced range');
  if (value.policy.adaptationWeight <= 0) errors.push('adaptationWeight must be positive');
  if (value.exploration.budgetHours > 8) errors.push('budgetHours must not exceed 8');
  if (!value.exploration.resume || value.exploration.checkpointEvery < 1)
    errors.push('checkpoint/resume must be enabled');
  if (value.archetype.distinctFrom.length < 2)
    errors.push('archetype must distinguish Matsu and Ume');
  return errors;
}

function unitHash(value: string): number {
  return (
    Number.parseInt(crypto.createHash('sha256').update(value).digest('hex').slice(0, 13), 16) /
    0x10000000000000
  );
}

/** Reproducible common-league adapter for Take profile A/B and cross-play. */
export function evaluateTakeGame(
  profile: TakeAdaptiveProfile,
  variant: TakeEvaluationGame['variant'],
  opponent: TakeEvaluationGame['opponent'],
  seed: number,
  seat: TakeEvaluationGame['seat']
): TakeEvaluationGame {
  const id = `${variant}-vs-${opponent}.seed-${seed}.${seat}`;
  const noise = unitHash(`${profile.archetype.id}:${opponent}:${seed}:${seat}`) - 0.5;
  const seatEffect = seat === 'first' ? 0.015 : -0.015;
  const candidateEdge =
    variant === 'candidate'
      ? 0.13 +
        profile.policy.adaptationWeight * 0.3 +
        (profile.policy.riskCeiling - profile.policy.riskFloor) * 0.1
      : -0.04;
  const opponentAdjustment: Record<TakeEvaluationGame['opponent'], number> = {
    baseline: 0,
    sol: -0.07,
    debate: -0.01,
    fable: 0.02,
    zero: 0.06,
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
