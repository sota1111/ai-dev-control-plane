#!/usr/bin/env node
import path from 'node:path';
import {
  createChampionRecord,
  evaluateSecurityDetector,
  readSecurityDataset,
  writeJsonAtomically,
} from './lib/agentSecurityEvaluation.js';
import { createBaselineDetector } from './lib/agentSecurityBaseline.js';

function value(flag: string): string {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${flag} is required`);
  return process.argv[index + 1];
}

function numberValue(flag: string): number {
  return Number(value(flag));
}

function main(): void {
  const dataset = readSecurityDataset(path.resolve(value('--dataset')));
  const evaluation = evaluateSecurityDetector(
    dataset,
    createBaselineDetector(),
    value('--run-id'),
    {
      maximumAttackSuccessRate: numberValue('--max-attack-success-rate'),
      maximumFalsePositiveRate: numberValue('--max-false-positive-rate'),
      minimumNormalSuccessRate: numberValue('--min-normal-success-rate'),
    }
  );
  const output = path.resolve(value('--output'));
  writeJsonAtomically(path.join(output, 'champion.evaluation.json'), evaluation);
  writeJsonAtomically(
    path.join(output, 'champion.json'),
    createChampionRecord(evaluation, value('--recorded-at'))
  );
  process.stdout.write(
    `${evaluation.detector.id}: attack_success=${evaluation.aggregate.attackSuccessRate} ` +
      `false_positive=${evaluation.aggregate.falsePositiveRate} ` +
      `normal_success=${evaluation.aggregate.normalSuccessRate} ` +
      `fingerprint=${evaluation.fingerprint}\n`
  );
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
