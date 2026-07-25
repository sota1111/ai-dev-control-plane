import crypto from 'node:crypto';
import {
  createChampionRegistry,
  evaluateArcAgi3Candidate,
  promoteChampion,
  type ArcAgi3Agent,
  type ArcAgi3Environment,
  type ArcAgi3Evaluation,
  type ArcAgi3EvaluationPlan,
  type ChampionRegistry,
} from './arcAgi3Evaluation.js';

export type BaselineAction = { choice: number };
export type BaselineObservation = { signal: number; legalActions: number[] };

export interface BaselineEvaluationResult {
  schemaVersion: 'arc-agi-3-baseline-decision/v1';
  plan: ArcAgi3EvaluationPlan;
  evaluations: ArcAgi3Evaluation[];
  promotion: {
    candidateId: string | null;
    reason: string;
    confirmMinimumMean: number;
    controlCandidateId: string;
  };
  championRegistry: ChampionRegistry;
}

/**
 * A deterministic contract fixture for comparing baseline policies before a real ARC adapter is
 * supplied. The observation exposes the legal action set and a minimal task signal; illegal actions
 * fail immediately instead of silently influencing a score.
 */
export class BaselineContractEnvironment implements ArcAgi3Environment<
  BaselineAction,
  BaselineObservation
> {
  readonly environmentId = 'arc-agi-3-baseline-contract';
  readonly environmentVersion = '1.0.0';
  private seed = 0;
  private stepIndex = 0;

  reset(seed: number) {
    this.seed = seed;
    this.stepIndex = 0;
    return { observation: this.observation() };
  }

  step(action: BaselineAction) {
    if (!Number.isInteger(action.choice) || ![0, 1, 2].includes(action.choice))
      throw new Error(`illegal action: ${JSON.stringify(action)}`);
    const reward = action.choice === this.signal() ? 1 : 0;
    this.stepIndex += 1;
    return {
      observation: this.observation(),
      reward,
      terminated: this.stepIndex >= 4,
    };
  }

  private signal(): number {
    return (this.seed * 7 + this.stepIndex * 5 + 1) % 3;
  }

  private observation(): BaselineObservation {
    return { signal: this.signal(), legalActions: [0, 1, 2] };
  }
}

function deterministicChoice(seed: number, step: number): number {
  const digest = crypto.createHash('sha256').update(`${seed}:${step}:random-v1`).digest();
  return digest[0] % 3;
}

export function createRandomControl(
  artifactId: string
): ArcAgi3Agent<BaselineAction, BaselineObservation> {
  return {
    candidateId: 'random-control-v1',
    artifactId,
    act: ({ seed, step }) => ({ choice: deterministicChoice(seed, step) }),
  };
}

export function createObservationRule(
  artifactId: string
): ArcAgi3Agent<BaselineAction, BaselineObservation> {
  return {
    candidateId: 'observation-rule-v1',
    artifactId,
    act: ({ observation }) => {
      if (!observation.legalActions.includes(observation.signal))
        throw new Error('signal is not a legal action');
      return { choice: observation.signal };
    },
  };
}

export async function evaluateInitialBaselines(
  artifactId: string,
  promotedAt: string,
  plan: ArcAgi3EvaluationPlan,
  confirmMinimumMean = 3
): Promise<BaselineEvaluationResult> {
  const createEnvironment = () => new BaselineContractEnvironment();
  const control = await evaluateArcAgi3Candidate(
    plan,
    createEnvironment,
    createRandomControl(artifactId)
  );
  const rule = await evaluateArcAgi3Candidate(
    plan,
    createEnvironment,
    createObservationRule(artifactId)
  );
  const evaluations = [control, rule];
  const controlConfirm = control.stages.find((stage) => stage.name === 'confirm')?.meanScore;
  const ruleConfirm = rule.stages.find((stage) => stage.name === 'confirm')?.meanScore;
  const eligible =
    ruleConfirm !== undefined &&
    ruleConfirm >= confirmMinimumMean &&
    (controlConfirm === undefined || ruleConfirm > controlConfirm);
  const emptyRegistry = createChampionRegistry(rule);
  const championRegistry = eligible
    ? promoteChampion(emptyRegistry, rule, promotedAt)
    : emptyRegistry;
  return {
    schemaVersion: 'arc-agi-3-baseline-decision/v1',
    plan,
    evaluations,
    promotion: {
      candidateId: eligible ? rule.candidate.id : null,
      reason: eligible
        ? `confirm mean ${ruleConfirm} met ${confirmMinimumMean} and exceeded control ${controlConfirm ?? 'screen-rejected'}`
        : `rule confirm mean ${ruleConfirm ?? 'not run'} did not clear the promotion gate`,
      confirmMinimumMean,
      controlCandidateId: control.candidate.id,
    },
    championRegistry,
  };
}
