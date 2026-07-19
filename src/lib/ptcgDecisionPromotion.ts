import type { PairedCandidateReport } from './ptcgPairedEvaluation.js';

export const DECISION_POLICY_VERSION = 'matsu-decision-policy/v1' as const;

export type DecisionScene =
  | 'opening-board'
  | 'evolution-window'
  | 'prize-trade'
  | 'disruption-recovery';

export interface TraceDecision {
  scene: DecisionScene;
  matchup: 'alakazam' | 'mega-lucario' | 'other';
  traceRef: string;
  failure: string;
  expectedAction: string;
  policyChange: string;
  regressionPassed: boolean;
}

export interface MatchupDelta {
  matchup: string;
  winRateDifference: number;
}

export interface DecisionOption {
  id: string;
  baseScore: number;
  exposesMultiPrize?: boolean;
  establishesDrawPivot?: boolean;
  actionableEvolution?: boolean;
  strandedEvolution?: boolean;
  replyPrizeLiability?: number;
  restoresContinuity?: boolean;
  optionalDevelopment?: boolean;
}

/** Minimal, trace-derived adjustment layered over the champion's existing action score. */
export function choosePolicyAction(
  scene: DecisionScene,
  options: readonly DecisionOption[]
): string {
  if (options.length === 0) throw new Error('at least one decision option is required');
  const adjusted = options.map((option) => {
    let score = option.baseScore;
    if (scene === 'opening-board') {
      if (option.exposesMultiPrize && !option.establishesDrawPivot) score -= 3;
      if (option.establishesDrawPivot) score += 2;
    } else if (scene === 'evolution-window') {
      if (option.actionableEvolution) score += 2;
      if (option.strandedEvolution) score -= 3;
    } else if (scene === 'prize-trade') {
      score -= option.replyPrizeLiability ?? 0;
    } else if (scene === 'disruption-recovery') {
      if (option.restoresContinuity) score += 3;
      if (option.optionalDevelopment && !option.restoresContinuity) score -= 2;
    }
    return { id: option.id, score };
  });
  adjusted.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return adjusted[0].id;
}

export interface PromotionInput {
  version: string;
  artifact: string;
  deckId: string;
  tactic: string;
  paired: PairedCandidateReport;
  decisions: readonly TraceDecision[];
  matchupDeltas: readonly MatchupDelta[];
  baselineRuntimeMs: number;
  candidateRuntimeMs: number;
}

export interface PromotionVerdict extends PromotionInput {
  schemaVersion: typeof DECISION_POLICY_VERSION;
  promoted: boolean;
  submissionEligible: boolean;
  reasons: string[];
}

const REQUIRED_SCENES: readonly DecisionScene[] = [
  'opening-board',
  'evolution-window',
  'prize-trade',
  'disruption-recovery',
];

/**
 * Conservative candidate gate. A candidate is submit-worthy only when the paired 95% CI is wholly
 * positive, every required replay scene passes, severe matchups do not regress, reliability does
 * not worsen, and mean runtime stays within the declared budget.
 */
export function evaluatePromotion(input: PromotionInput): PromotionVerdict {
  const reasons: string[] = [];
  const scenes = new Map(input.decisions.map((decision) => [decision.scene, decision]));
  for (const scene of REQUIRED_SCENES) {
    const decision = scenes.get(scene);
    if (!decision) reasons.push(`missing replay evidence: ${scene}`);
    else if (!decision.regressionPassed) reasons.push(`scene regression failed: ${scene}`);
  }
  if (input.paired.confidence95.low <= 0) reasons.push('paired 95% CI is not wholly above zero');
  for (const row of input.matchupDeltas) {
    if (row.winRateDifference < 0) reasons.push(`major matchup regressed: ${row.matchup}`);
  }
  if (input.paired.faults.candidate > input.paired.faults.baseline) {
    reasons.push('candidate fault count increased');
  }
  if (input.paired.timeouts.candidate > input.paired.timeouts.baseline) {
    reasons.push('candidate timeout count increased');
  }
  if (input.baselineRuntimeMs <= 0 || input.candidateRuntimeMs > input.baselineRuntimeMs * 1.1) {
    reasons.push('candidate runtime exceeds 110% of baseline');
  }
  const promoted = reasons.length === 0;
  return {
    schemaVersion: DECISION_POLICY_VERSION,
    ...input,
    promoted,
    submissionEligible: promoted,
    reasons,
  };
}
