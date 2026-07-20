import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EVALUATION_PROTOCOL_VERSION,
  buildEvaluationPlan,
  runEvaluation,
  type EvaluationProtocol,
} from '../lib/ptcgEvaluationHarness.js';
import { REDACTED_EMAIL, REDACTED_PATH, REDACTED_SECRET } from '../lib/ptcgArtifactRedaction.js';
import { replayTelemetry, writeTelemetryArtifact } from '../lib/ptcgTrainingTelemetry.js';

const evaluationProtocol = (seed = 123): EvaluationProtocol => ({
  protocolVersion: EVALUATION_PROTOCOL_VERSION,
  environmentVersion: 'engine-v1',
  baseSeed: seed,
  repetitions: 2,
  decks: [{ id: 'deck-a', contentHash: 'sha256:deck-a' }],
  opponentPool: [{ snapshotId: 'opponent-a', artifactId: 'model:opponent-a' }],
  methods: [{ id: 'method-a', artifactId: 'model:method-a' }],
});

describe('evaluation correctness, reproducibility, and artifact redaction', () => {
  it('keeps fixed-seed plans and outcomes identical while a changed seed changes the plan', async () => {
    const runner = async (match: { seed: number }) => ({
      winner: (match.seed % 2 ? 'method' : 'opponent') as 'method' | 'opponent',
    });
    const first = await runEvaluation(evaluationProtocol(), { 'method-a': runner });
    const replay = await runEvaluation(evaluationProtocol(), { 'method-a': runner });
    expect(replay).toEqual(first);
    expect(buildEvaluationPlan(evaluationProtocol(124)).map((match) => match.seed)).not.toEqual(
      buildEvaluationPlan(evaluationProtocol()).map((match) => match.seed)
    );
  });

  it('computes known aggregates and reproduces derived artifacts byte-for-byte', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaluation-safety-'));
    const metadata = {
      runId: 'known-input',
      createdAt: '2026-07-20T00:00:00.000Z',
      codeVersion: 'abc123',
      seed: 7,
      command: 'train --seed 7',
      conditions: { backend: 'fixture' },
    };
    writeTelemetryArtifact(root, metadata, [
      { step: 0, metric: 'reward', value: 1 },
      { step: 1, metric: 'reward', value: 3 },
      { step: 2, metric: 'reward', value: 5 },
    ]);
    const first = replayTelemetry(root, metadata.runId);
    expect(first.aggregate.series[0]).toMatchObject({ min: 1, max: 5, mean: 3, last: 5 });
    const aggregate = fs.readFileSync(first.aggregatePath);
    const events = fs.readFileSync(first.tensorBoardPath);
    const replay = replayTelemetry(root, metadata.runId);
    expect(fs.readFileSync(replay.aggregatePath)).toEqual(aggregate);
    expect(fs.readFileSync(replay.tensorBoardPath)).toEqual(events);
  });

  it('redacts secrets, personal email, and host paths from telemetry and evaluation artifacts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaluation-redaction-'));
    const githubToken = ['ghp', 'abcdefghijklmnop'].join('_');
    const apiKey = ['sk', 'supersecret123'].join('-');
    const manifest = writeTelemetryArtifact(
      root,
      {
        runId: 'sensitive-input',
        createdAt: '2026-07-20T00:00:00.000Z',
        codeVersion: 'abc123',
        seed: 7,
        command: `train --token ${githubToken} --input /home/alice/private/data.json`,
        conditions: { email: 'alice@example.com', apiKey },
      },
      [{ step: 0, metric: 'loss', value: 0.5 }]
    );
    const run = await runEvaluation(evaluationProtocol(), {
      'method-a': async () => ({
        winner: 'draw',
        metadata: {
          authorization: 'Bearer private-token',
          owner: 'alice@example.com',
          source: '/workspaces/private/model.bin',
        },
      }),
    });
    const persisted = fs.readFileSync(
      path.join(root, manifest.metadata.runId, 'manifest.json'),
      'utf8'
    );
    const serialized = `${persisted}\n${JSON.stringify(run)}`;
    for (const leak of [
      githubToken,
      '/home/alice/private/data.json',
      'alice@example.com',
      apiKey,
      'private-token',
      '/workspaces/private/model.bin',
    ]) {
      expect(serialized).not.toContain(leak);
    }
    expect(serialized).toContain(REDACTED_SECRET);
    expect(serialized).toContain(REDACTED_EMAIL);
    expect(serialized).toContain(REDACTED_PATH);
  });
});
