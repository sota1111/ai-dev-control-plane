#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  evaluateArcAgi3Candidate,
  writeEvaluationArtifact,
  type ArcAgi3Agent,
  type ArcAgi3Environment,
  type JsonValue,
} from './lib/arcAgi3Evaluation.js';

type Plugin = {
  createEnvironment: () => ArcAgi3Environment<JsonValue, JsonValue>;
  createAgent: () => ArcAgi3Agent<JsonValue, JsonValue>;
};

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
  const modulePath = path.resolve(value('--module'));
  const plugin = (await import(pathToFileURL(modulePath).href)) as Partial<Plugin>;
  if (typeof plugin.createEnvironment !== 'function' || typeof plugin.createAgent !== 'function')
    throw new Error('module must export createEnvironment() and createAgent()');
  const output = path.resolve(value('--output'));
  const evaluation = await evaluateArcAgi3Candidate(
    {
      runId: value('--run-id'),
      screenSeeds: seeds('--screen-seeds'),
      confirmSeeds: seeds('--confirm-seeds'),
      maxSteps: Number(value('--max-steps')),
      screenMinimumMean: Number(value('--screen-minimum-mean')),
    },
    plugin.createEnvironment,
    plugin.createAgent()
  );
  writeEvaluationArtifact(output, evaluation);
  process.stdout.write(
    `${evaluation.candidate.id}: screen=${evaluation.stages[0].meanScore} confirm=${evaluation.gate.confirmExecuted ? evaluation.stages[1].meanScore : 'skipped'}\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
