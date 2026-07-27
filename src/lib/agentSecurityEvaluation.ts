import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const AGENT_SECURITY_DATASET_SCHEMA = 'agent-security-dataset/v1' as const;
export const AGENT_SECURITY_EVALUATION_SCHEMA = 'agent-security-evaluation/v1' as const;
export const AGENT_SECURITY_CHAMPION_SCHEMA = 'agent-security-champion/v1' as const;

export type SecurityLabel = 'attack' | 'normal';
export type SecurityDecision = 'block' | 'allow';
export type EvaluationStageName = 'screen' | 'confirm';

export interface SecurityCase {
  id: string;
  split: EvaluationStageName;
  label: SecurityLabel;
  input: {
    userMessage: string;
    toolName: string;
    toolOutput: string;
  };
  expected: SecurityDecision;
}

export interface SecurityDataset {
  schemaVersion: typeof AGENT_SECURITY_DATASET_SCHEMA;
  datasetId: string;
  cases: SecurityCase[];
}

export interface SecurityDetector {
  detectorId: string;
  artifactId: string;
  decide(input: Readonly<SecurityCase['input']>): SecurityDecision;
}

export interface SecurityMetrics {
  attackCases: number;
  successfulAttacks: number;
  attackSuccessRate: number;
  normalCases: number;
  falsePositives: number;
  falsePositiveRate: number;
  normalSuccessRate: number;
}

export interface CaseResult {
  caseId: string;
  label: SecurityLabel;
  expected: SecurityDecision;
  actual: SecurityDecision;
  attackSucceeded: boolean;
  falsePositive: boolean;
  passed: boolean;
}

export interface EvaluationStage {
  name: EvaluationStageName;
  caseIds: string[];
  results: CaseResult[];
  metrics: SecurityMetrics;
}

export interface SecurityThresholds {
  maximumAttackSuccessRate: number;
  maximumFalsePositiveRate: number;
  minimumNormalSuccessRate: number;
}

export interface AgentSecurityEvaluation {
  schemaVersion: typeof AGENT_SECURITY_EVALUATION_SCHEMA;
  runId: string;
  dataset: { id: string; fingerprint: string };
  detector: { id: string; artifactId: string };
  thresholds: SecurityThresholds;
  stages: EvaluationStage[];
  gate: {
    screenPassed: boolean;
    confirmExecuted: boolean;
  };
  aggregate: SecurityMetrics;
  fingerprint: string;
}

export interface ChampionRecord {
  schemaVersion: typeof AGENT_SECURITY_CHAMPION_SCHEMA;
  champion: {
    detectorId: string;
    artifactId: string;
    evaluationFingerprint: string;
    metrics: SecurityMetrics;
    recordedAt: string;
  };
}

export type CandidateDisposition =
  | {
      outcome: 'reject';
      requiredActions: ['revert_candidate_changes', 'record_results_in_docs'];
      reason: string;
    }
  | {
      outcome: 'promote';
      requiredActions: ['verify_exec_compatibility', 'run_kaggle_proof'];
      reason: string;
    };

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

function validateRate(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error(`${name} must be between 0 and 1`);
}

export function validateDataset(dataset: SecurityDataset): void {
  if (dataset.schemaVersion !== AGENT_SECURITY_DATASET_SCHEMA)
    throw new Error(`unsupported dataset schema: ${dataset.schemaVersion}`);
  if (!dataset.datasetId.trim()) throw new Error('datasetId is required');
  if (!dataset.cases.length) throw new Error('dataset cases must not be empty');
  const ids = new Set<string>();
  for (const testCase of dataset.cases) {
    if (!testCase.id.trim() || ids.has(testCase.id)) throw new Error('case ids must be unique');
    ids.add(testCase.id);
    if (testCase.expected !== (testCase.label === 'attack' ? 'block' : 'allow'))
      throw new Error(`${testCase.id}: expected decision must match label`);
    if (
      !testCase.input.userMessage.trim() ||
      !testCase.input.toolName.trim() ||
      !testCase.input.toolOutput.trim()
    )
      throw new Error(`${testCase.id}: input fields must not be empty`);
  }
  for (const split of ['screen', 'confirm'] as const) {
    const cases = dataset.cases.filter((testCase) => testCase.split === split);
    if (!cases.some((testCase) => testCase.label === 'attack'))
      throw new Error(`${split} must contain attack cases`);
    if (!cases.some((testCase) => testCase.label === 'normal'))
      throw new Error(`${split} must contain normal cases`);
  }
}

function metrics(results: CaseResult[]): SecurityMetrics {
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

function runStage(
  name: EvaluationStageName,
  cases: SecurityCase[],
  detector: SecurityDetector
): EvaluationStage {
  const results = cases.map((testCase): CaseResult => {
    const actual = detector.decide(testCase.input);
    if (actual !== 'allow' && actual !== 'block')
      throw new Error(`${testCase.id}: detector returned an invalid decision`);
    return {
      caseId: testCase.id,
      label: testCase.label,
      expected: testCase.expected,
      actual,
      attackSucceeded: testCase.label === 'attack' && actual === 'allow',
      falsePositive: testCase.label === 'normal' && actual === 'block',
      passed: actual === testCase.expected,
    };
  });
  return {
    name,
    caseIds: cases.map((testCase) => testCase.id),
    results,
    metrics: metrics(results),
  };
}

export function meetsThresholds(actual: SecurityMetrics, thresholds: SecurityThresholds): boolean {
  return (
    actual.attackSuccessRate <= thresholds.maximumAttackSuccessRate &&
    actual.falsePositiveRate <= thresholds.maximumFalsePositiveRate &&
    actual.normalSuccessRate >= thresholds.minimumNormalSuccessRate
  );
}

export function evaluateSecurityDetector(
  dataset: SecurityDataset,
  detector: SecurityDetector,
  runId: string,
  thresholds: SecurityThresholds
): AgentSecurityEvaluation {
  validateDataset(dataset);
  if (!runId.trim()) throw new Error('runId is required');
  if (!detector.detectorId.trim() || !detector.artifactId.trim())
    throw new Error('detector id and artifact id are required');
  validateRate('maximumAttackSuccessRate', thresholds.maximumAttackSuccessRate);
  validateRate('maximumFalsePositiveRate', thresholds.maximumFalsePositiveRate);
  validateRate('minimumNormalSuccessRate', thresholds.minimumNormalSuccessRate);

  const screenCases = dataset.cases.filter((testCase) => testCase.split === 'screen');
  const confirmCases = dataset.cases.filter((testCase) => testCase.split === 'confirm');
  const screen = runStage('screen', screenCases, detector);
  const screenPassed = meetsThresholds(screen.metrics, thresholds);
  const stages = [screen];
  if (screenPassed) stages.push(runStage('confirm', confirmCases, detector));
  const allResults = stages.flatMap((stage) => stage.results);
  const withoutFingerprint = {
    schemaVersion: AGENT_SECURITY_EVALUATION_SCHEMA,
    runId,
    dataset: { id: dataset.datasetId, fingerprint: fingerprint(dataset) },
    detector: { id: detector.detectorId, artifactId: detector.artifactId },
    thresholds: { ...thresholds },
    stages,
    gate: { screenPassed, confirmExecuted: screenPassed },
    aggregate: metrics(allResults),
  };
  return { ...withoutFingerprint, fingerprint: fingerprint(withoutFingerprint) };
}

export function compareCandidate(
  champion: AgentSecurityEvaluation,
  candidate: AgentSecurityEvaluation
): CandidateDisposition {
  if (
    champion.dataset.fingerprint !== candidate.dataset.fingerprint ||
    champion.thresholds.maximumAttackSuccessRate !==
      candidate.thresholds.maximumAttackSuccessRate ||
    champion.thresholds.maximumFalsePositiveRate !==
      candidate.thresholds.maximumFalsePositiveRate ||
    champion.thresholds.minimumNormalSuccessRate !== candidate.thresholds.minimumNormalSuccessRate
  )
    throw new Error('champion and candidate must use the same dataset and thresholds');
  if (!candidate.gate.confirmExecuted) {
    return {
      outcome: 'reject',
      requiredActions: ['revert_candidate_changes', 'record_results_in_docs'],
      reason: 'candidate did not pass screen',
    };
  }
  const incumbent = champion.aggregate;
  const challenger = candidate.aggregate;
  const noRegression =
    challenger.attackSuccessRate <= incumbent.attackSuccessRate &&
    challenger.falsePositiveRate <= incumbent.falsePositiveRate &&
    challenger.normalSuccessRate >= incumbent.normalSuccessRate;
  const strictImprovement =
    challenger.attackSuccessRate < incumbent.attackSuccessRate ||
    challenger.falsePositiveRate < incumbent.falsePositiveRate ||
    challenger.normalSuccessRate > incumbent.normalSuccessRate;
  if (!noRegression || !strictImprovement) {
    return {
      outcome: 'reject',
      requiredActions: ['revert_candidate_changes', 'record_results_in_docs'],
      reason: 'candidate did not strictly dominate the champion metrics',
    };
  }
  return {
    outcome: 'promote',
    requiredActions: ['verify_exec_compatibility', 'run_kaggle_proof'],
    reason: 'candidate passed confirm and strictly dominated the champion metrics',
  };
}

export function createChampionRecord(
  evaluation: AgentSecurityEvaluation,
  recordedAt: string
): ChampionRecord {
  if (
    !evaluation.gate.confirmExecuted ||
    !meetsThresholds(evaluation.aggregate, evaluation.thresholds)
  )
    throw new Error('champion must pass screen and confirm thresholds');
  if (Number.isNaN(Date.parse(recordedAt))) throw new Error('recordedAt must be ISO-8601');
  return {
    schemaVersion: AGENT_SECURITY_CHAMPION_SCHEMA,
    champion: {
      detectorId: evaluation.detector.id,
      artifactId: evaluation.detector.artifactId,
      evaluationFingerprint: evaluation.fingerprint,
      metrics: { ...evaluation.aggregate },
      recordedAt,
    },
  };
}

export function readSecurityDataset(file: string): SecurityDataset {
  const dataset = JSON.parse(fs.readFileSync(file, 'utf8')) as SecurityDataset;
  validateDataset(dataset);
  return dataset;
}

export function writeJsonAtomically(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}
