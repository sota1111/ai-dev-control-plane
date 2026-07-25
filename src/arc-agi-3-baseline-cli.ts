#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { evaluateInitialBaselines } from './lib/arcAgi3Baselines.js';
import { writeChampionRegistry, writeEvaluationArtifact } from './lib/arcAgi3Evaluation.js';

function value(flag: string): string {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${flag} is required`);
  return process.argv[index + 1];
}

function seeds(flag: string): number[] {
  return value(flag)
    .split(',')
    .map((item) => Number(item));
}

async function main(): Promise<void> {
  const outputDirectory = path.resolve(value('--output'));
  const result = await evaluateInitialBaselines(value('--artifact-id'), value('--promoted-at'), {
    runId: value('--run-id'),
    screenSeeds: seeds('--screen-seeds'),
    confirmSeeds: seeds('--confirm-seeds'),
    maxSteps: Number(value('--max-steps')),
    screenMinimumMean: Number(value('--screen-minimum-mean')),
  });
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const evaluation of result.evaluations)
    writeEvaluationArtifact(
      path.join(outputDirectory, `${evaluation.candidate.id}.evaluation.json`),
      evaluation
    );
  writeChampionRegistry(path.join(outputDirectory, 'champion.json'), result.championRegistry);
  fs.writeFileSync(
    path.join(outputDirectory, 'decision.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8'
  );
  process.stdout.write(
    `${result.promotion.candidateId ?? 'no candidate'}: ${result.promotion.reason}\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
