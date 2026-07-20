import fs from 'node:fs';
import path from 'node:path';
import { assertArtifactRedacted } from './ptcgArtifactRedaction.js';
import type { StatisticalBenchmarkReport } from './ptcgStatisticalBenchmark.js';

export const RELEASE_GATE_SCHEMA = 'ptcg-release-gate/v1' as const;

export interface ReleaseGateInput {
  generatedAt: string;
  mode: 'smoke' | 'scheduled';
  benchmark: StatisticalBenchmarkReport;
  durationMs: number;
  maximumDurationMs: number;
  artifact: unknown;
}

export interface ReleaseGateCheck {
  name: 'correctness' | 'performance' | 'information-leakage';
  passed: boolean;
  evidence: string;
}

export interface ReleaseGateReport {
  schemaVersion: typeof RELEASE_GATE_SCHEMA;
  generatedAt: string;
  mode: ReleaseGateInput['mode'];
  conditionsFingerprint: string;
  checks: ReleaseGateCheck[];
  passed: boolean;
}

/** Build the release decision from independently reviewable benchmark evidence. */
export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateReport {
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0)
    throw new Error('durationMs must be finite and non-negative');
  if (!Number.isFinite(input.maximumDurationMs) || input.maximumDurationMs <= 0)
    throw new Error('maximumDurationMs must be finite and positive');

  let leakPassed = true;
  let leakEvidence = 'artifact passed structural redaction scan';
  try {
    assertArtifactRedacted(input.artifact);
  } catch {
    leakPassed = false;
    leakEvidence = 'artifact contains unredacted sensitive information';
  }

  const checks: ReleaseGateCheck[] = [
    {
      name: 'correctness',
      passed: input.benchmark.passed,
      evidence: input.benchmark.results
        .map((result) => `${result.methodId}:${result.classification}`)
        .join(', '),
    },
    {
      name: 'performance',
      passed: input.durationMs <= input.maximumDurationMs,
      evidence: `${input.durationMs}ms <= ${input.maximumDurationMs}ms`,
    },
    { name: 'information-leakage', passed: leakPassed, evidence: leakEvidence },
  ];
  return {
    schemaVersion: RELEASE_GATE_SCHEMA,
    generatedAt: input.generatedAt,
    mode: input.mode,
    conditionsFingerprint: input.benchmark.conditionsFingerprint,
    checks,
    passed: checks.every((check) => check.passed),
  };
}

export function writeReleaseGateArtifacts(
  directory: string,
  report: ReleaseGateReport
): { json: string; markdown: string } {
  fs.mkdirSync(directory, { recursive: true });
  const json = path.join(directory, 'release-gate.json');
  const markdown = path.join(directory, 'release-gate.md');
  fs.writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  const rows = report.checks
    .map((check) => `| ${check.name} | ${check.passed ? 'PASS' : 'FAIL'} | ${check.evidence} |`)
    .join('\n');
  fs.writeFileSync(
    markdown,
    `# PTCG benchmark release gate\n\n` +
      `- Result: **${report.passed ? 'PASS' : 'FAIL'}**\n` +
      `- Mode: \`${report.mode}\`\n` +
      `- Conditions: \`${report.conditionsFingerprint}\`\n\n` +
      `| Gate | Result | Evidence |\n| --- | --- | --- |\n${rows}\n`
  );
  return { json, markdown };
}
