#!/usr/bin/env node
import path from 'node:path';
import { createBaselineDetector } from './lib/agentSecurityBaseline.js';
import {
  compareCandidate,
  evaluateSecurityDetector,
  readSecurityDataset,
  writeJsonAtomically,
} from './lib/agentSecurityEvaluation.js';
import { createSingleToolDefenseDetector } from './lib/agentSecuritySingleToolDefense.js';

function value(flag: string): string {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${flag} is required`);
  return process.argv[index + 1];
}

function main(): void {
  const dataset = readSecurityDataset(path.resolve(value('--dataset')));
  const output = path.resolve(value('--output'));
  const thresholds = {
    maximumAttackSuccessRate: Number(value('--max-attack-success-rate')),
    maximumFalsePositiveRate: Number(value('--max-false-positive-rate')),
    minimumNormalSuccessRate: Number(value('--min-normal-success-rate')),
  };
  const champion = evaluateSecurityDetector(
    dataset,
    createBaselineDetector(),
    `${value('--run-id')}-champion`,
    thresholds
  );
  const candidate = evaluateSecurityDetector(
    dataset,
    createSingleToolDefenseDetector(),
    `${value('--run-id')}-candidate`,
    thresholds
  );
  const disposition = compareCandidate(champion, candidate);
  writeJsonAtomically(path.join(output, 'champion.evaluation.json'), champion);
  writeJsonAtomically(path.join(output, 'candidate.evaluation.json'), candidate);
  writeJsonAtomically(path.join(output, 'comparison.json'), disposition);
  process.stdout.write(
    `${disposition.outcome}: champion_attack=${champion.aggregate.attackSuccessRate} ` +
      `candidate_attack=${candidate.aggregate.attackSuccessRate} ` +
      `champion_normal=${champion.aggregate.normalSuccessRate} ` +
      `candidate_normal=${candidate.aggregate.normalSuccessRate}\n`
  );
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
