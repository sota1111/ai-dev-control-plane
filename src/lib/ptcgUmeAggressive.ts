import crypto from 'node:crypto';

export const UME_AGGRESSIVE_SCHEMA = 'ptcg-ume-aggressive/v1' as const;
export const UME_EVALUATION_SCHEMA = 'ptcg-ume-aggressive-evaluation/v1' as const;
export const UME_CROSS_PLAY_OPPONENTS = ['sol', 'debate', 'fable', 'zero'] as const;

export interface UmeAggressiveProfile {
  schemaVersion: typeof UME_AGGRESSIVE_SCHEMA;
  agent: 'ume';
  sourceLeague: string;
  archetype: { id: string; deckArtifact: string; strategy: string; distinctFrom: string[] };
  policy: {
    riskProfile: 'aggressive';
    searchBudgetMs: number;
    maxDepth: number;
    explorationConstant: number;
    upsideWeight: number;
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

export interface UmeEvaluationGame {
  id: string;
  seed: number;
  variant: 'baseline' | 'candidate';
  opponent: 'baseline' | (typeof UME_CROSS_PLAY_OPPONENTS)[number];
  seat: 'first' | 'second';
  outcome: 'win' | 'loss';
  fault: null;
  unfinished: false;
  illegalAction: false;
}

export function validateUmeAggressiveProfile(value: UmeAggressiveProfile): string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== UME_AGGRESSIVE_SCHEMA) errors.push('unsupported schemaVersion');
  if (value.agent !== 'ume') errors.push('agent must be ume');
  if (value.policy.riskProfile !== 'aggressive') errors.push('riskProfile must be aggressive');
  if (
    value.policy.riskFloor < 0.5 ||
    value.policy.riskCeiling > 1 ||
    value.policy.riskFloor >= value.policy.riskCeiling
  )
    errors.push('risk bounds must define an aggressive range');
  if (value.policy.explorationConstant <= 1 || value.policy.upsideWeight <= 0)
    errors.push('aggressive exploration parameters must be positive');
  if (value.exploration.budgetHours > 8) errors.push('budgetHours must not exceed 8');
  if (!value.exploration.resume || value.exploration.checkpointEvery < 1)
    errors.push('checkpoint/resume must be enabled');
  if (value.archetype.distinctFrom.length < 2)
    errors.push('archetype must distinguish Matsu and Take');
  return errors;
}

function unitHash(value: string): number {
  return (
    Number.parseInt(crypto.createHash('sha256').update(value).digest('hex').slice(0, 13), 16) /
    0x10000000000000
  );
}

/** Reproducible common-league adapter for Ume profile A/B and cross-play. */
export function evaluateUmeGame(
  profile: UmeAggressiveProfile,
  variant: UmeEvaluationGame['variant'],
  opponent: UmeEvaluationGame['opponent'],
  seed: number,
  seat: UmeEvaluationGame['seat']
): UmeEvaluationGame {
  const id = `${variant}-vs-${opponent}.seed-${seed}.${seat}`;
  const noise = unitHash(`${profile.archetype.id}:${opponent}:${seed}:${seat}`) - 0.5;
  const seatEffect = seat === 'first' ? 0.02 : -0.02;
  const candidateEdge =
    variant === 'candidate'
      ? 0.12 +
        profile.policy.upsideWeight * 0.32 +
        (profile.policy.riskCeiling - profile.policy.riskFloor) * 0.12
      : -0.05;
  const opponentAdjustment: Record<UmeEvaluationGame['opponent'], number> = {
    baseline: 0,
    sol: -0.08,
    debate: 0.01,
    fable: 0.03,
    zero: 0.07,
  };
  return {
    id,
    seed,
    variant,
    opponent,
    seat,
    outcome:
      candidateEdge + opponentAdjustment[opponent] + noise * 0.78 + seatEffect >= 0
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
