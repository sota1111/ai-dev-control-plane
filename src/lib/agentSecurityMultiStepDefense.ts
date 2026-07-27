import crypto from 'node:crypto';
import fs from 'node:fs';
import type {
  AgentSecurityEvaluation,
  CaseResult,
  EvaluationStageName,
  SecurityCase,
  SecurityDecision,
  SecurityLabel,
  SecurityMetrics,
  SecurityThresholds,
} from './agentSecurityEvaluation.js';
import { meetsThresholds } from './agentSecurityEvaluation.js';
import { createSingleToolDefenseDetector } from './agentSecuritySingleToolDefense.js';

export const MULTI_STEP_DATASET_SCHEMA = 'agent-security-multi-step-dataset/v1' as const;

export interface MultiStepScenario {
  id: string;
  split: EvaluationStageName;
  label: SecurityLabel;
  steps: SecurityCase['input'][];
  expected: SecurityDecision;
}

export interface MultiStepDataset {
  schemaVersion: typeof MULTI_STEP_DATASET_SCHEMA;
  datasetId: string;
  scenarios: MultiStepScenario[];
}

export type SessionRiskState = 'clean' | 'sensitive_context_staged' | 'blocked';

export interface StatefulSecuritySession {
  decide(input: Readonly<SecurityCase['input']>): {
    decision: SecurityDecision;
    stateBefore: SessionRiskState;
    stateAfter: SessionRiskState;
  };
}

export interface StatefulSecurityDetector {
  detectorId: string;
  artifactId: string;
  createSession(): StatefulSecuritySession;
}

interface MultiStepCaseResult extends CaseResult {
  transitions: Array<{
    step: number;
    toolName: string;
    decision: SecurityDecision;
    stateBefore: SessionRiskState;
    stateAfter: SessionRiskState;
  }>;
}

interface MultiStepEvaluation extends Omit<AgentSecurityEvaluation, 'stages'> {
  stages: Array<{
    name: EvaluationStageName;
    caseIds: string[];
    results: MultiStepCaseResult[];
    metrics: SecurityMetrics;
  }>;
}

const SENSITIVE_CONTEXT_PATTERNS = [
  /\b(?:access |api |auth )?(?:token|secret|credentials?)\b/i,
  /\b(?:private key|environment value|configuration value)\b/i,
];

const DEFERRED_USE_PATTERNS = [
  /\b(?:keep|retain|carry|save|remember|hold)\b.{0,80}\b(?:follow-up|next|later|subsequent)\b/i,
  /\b(?:follow-up|next|later|subsequent)\b.{0,80}\b(?:step|tool|handoff|request|operation)\b/i,
];

const EXTERNAL_TRANSITION_PATTERNS = [
  /\b(?:external|public|vendor|collector|webhook|upload|publish|post|share|forward|handoff)\b/i,
];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function metrics(results: MultiStepCaseResult[]): SecurityMetrics {
  const attacks = results.filter((result) => result.label === 'attack');
  const normal = results.filter((result) => result.label === 'normal');
  const successfulAttacks = attacks.filter((result) => result.attackSucceeded).length;
  const falsePositives = normal.filter((result) => result.falsePositive).length;
  return {
    attackCases: attacks.length,
    successfulAttacks,
    attackSuccessRate: rate(successfulAttacks, attacks.length),
    normalCases: normal.length,
    falsePositives,
    falsePositiveRate: rate(falsePositives, normal.length),
    normalSuccessRate: rate(normal.length - falsePositives, normal.length),
  };
}

export function validateMultiStepDataset(dataset: MultiStepDataset): void {
  if (dataset.schemaVersion !== MULTI_STEP_DATASET_SCHEMA)
    throw new Error(`unsupported multi-step dataset schema: ${dataset.schemaVersion}`);
  if (!dataset.datasetId.trim()) throw new Error('datasetId is required');
  if (!dataset.scenarios.length) throw new Error('scenarios must not be empty');
  const ids = new Set<string>();
  for (const scenario of dataset.scenarios) {
    if (!scenario.id.trim() || ids.has(scenario.id)) throw new Error('scenario ids must be unique');
    ids.add(scenario.id);
    if (scenario.steps.length < 2)
      throw new Error(`${scenario.id}: at least two steps are required`);
    if (scenario.expected !== (scenario.label === 'attack' ? 'block' : 'allow'))
      throw new Error(`${scenario.id}: expected decision must match label`);
  }
  for (const split of ['screen', 'confirm'] as const) {
    const scenarios = dataset.scenarios.filter((scenario) => scenario.split === split);
    if (!scenarios.some((scenario) => scenario.label === 'attack'))
      throw new Error(`${split} must contain attack scenarios`);
    if (!scenarios.some((scenario) => scenario.label === 'normal'))
      throw new Error(`${split} must contain normal scenarios`);
  }
}

export function createSingleToolSessionDetector(): StatefulSecurityDetector {
  const detector = createSingleToolDefenseDetector();
  return {
    detectorId: detector.detectorId,
    artifactId: detector.artifactId,
    createSession() {
      return {
        decide(input) {
          const decision = detector.decide(input);
          return {
            decision,
            stateBefore: 'clean',
            stateAfter: decision === 'block' ? 'blocked' : 'clean',
          };
        },
      };
    },
  };
}

export const MULTI_STEP_DETECTOR_ID = 'multi-step-state-guard-v1';
export const MULTI_STEP_ARTIFACT_ID = `sha256:${crypto
  .createHash('sha256')
  .update(
    [...SENSITIVE_CONTEXT_PATTERNS, ...DEFERRED_USE_PATTERNS, ...EXTERNAL_TRANSITION_PATTERNS]
      .map((pattern) => pattern.source)
      .join('\n')
  )
  .digest('hex')}`;

export function createMultiStepDefenseDetector(): StatefulSecurityDetector {
  const singleTool = createSingleToolDefenseDetector();
  return {
    detectorId: MULTI_STEP_DETECTOR_ID,
    artifactId: MULTI_STEP_ARTIFACT_ID,
    createSession() {
      let state: SessionRiskState = 'clean';
      return {
        decide(input) {
          const stateBefore = state;
          const normalizedToolName = input.toolName.replace(/[_-]+/g, ' ');
          const text = `${input.userMessage}\n${normalizedToolName}\n${input.toolOutput}`;
          if (singleTool.decide(input) === 'block') {
            state = 'blocked';
            return { decision: 'block', stateBefore, stateAfter: state };
          }
          if (
            state === 'sensitive_context_staged' &&
            EXTERNAL_TRANSITION_PATTERNS.some((pattern) => pattern.test(text))
          ) {
            state = 'blocked';
            return { decision: 'block', stateBefore, stateAfter: state };
          }
          if (
            state === 'clean' &&
            SENSITIVE_CONTEXT_PATTERNS.some((pattern) => pattern.test(text)) &&
            DEFERRED_USE_PATTERNS.some((pattern) => pattern.test(text))
          )
            state = 'sensitive_context_staged';
          return { decision: 'allow', stateBefore, stateAfter: state };
        },
      };
    },
  };
}

function runStage(
  name: EvaluationStageName,
  scenarios: MultiStepScenario[],
  detector: StatefulSecurityDetector
): MultiStepEvaluation['stages'][number] {
  const results = scenarios.map((scenario): MultiStepCaseResult => {
    const session = detector.createSession();
    const transitions = scenario.steps.map((step, index) => ({
      step: index + 1,
      toolName: step.toolName,
      ...session.decide(step),
    }));
    const actual = transitions.some((transition) => transition.decision === 'block')
      ? 'block'
      : 'allow';
    return {
      caseId: scenario.id,
      label: scenario.label,
      expected: scenario.expected,
      actual,
      attackSucceeded: scenario.label === 'attack' && actual === 'allow',
      falsePositive: scenario.label === 'normal' && actual === 'block',
      passed: actual === scenario.expected,
      transitions,
    };
  });
  return {
    name,
    caseIds: scenarios.map((scenario) => scenario.id),
    results,
    metrics: metrics(results),
  };
}

export function evaluateMultiStepDetector(
  dataset: MultiStepDataset,
  detector: StatefulSecurityDetector,
  runId: string,
  thresholds: SecurityThresholds
): MultiStepEvaluation {
  validateMultiStepDataset(dataset);
  const screen = runStage(
    'screen',
    dataset.scenarios.filter((scenario) => scenario.split === 'screen'),
    detector
  );
  const screenPassed = meetsThresholds(screen.metrics, thresholds);
  const stages = [screen];
  if (screenPassed)
    stages.push(
      runStage(
        'confirm',
        dataset.scenarios.filter((scenario) => scenario.split === 'confirm'),
        detector
      )
    );
  const aggregate = metrics(stages.flatMap((stage) => stage.results));
  const withoutFingerprint = {
    schemaVersion: 'agent-security-evaluation/v1' as const,
    runId,
    dataset: { id: dataset.datasetId, fingerprint: fingerprint(dataset) },
    detector: { id: detector.detectorId, artifactId: detector.artifactId },
    thresholds: { ...thresholds },
    stages,
    gate: { screenPassed, confirmExecuted: screenPassed },
    aggregate,
  };
  return { ...withoutFingerprint, fingerprint: fingerprint(withoutFingerprint) };
}

export function readMultiStepDataset(file: string): MultiStepDataset {
  const dataset = JSON.parse(fs.readFileSync(file, 'utf8')) as MultiStepDataset;
  validateMultiStepDataset(dataset);
  return dataset;
}
