import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  replayTelemetry,
  TELEMETRY_GENERATOR_VERSION,
  TELEMETRY_SCHEMA_VERSION,
  writeTelemetryArtifact,
} from '../lib/ptcgTrainingTelemetry.js';

const metadata = {
  runId: 'train-001',
  createdAt: '2026-07-20T00:00:00.000Z',
  codeVersion: 'abc1234',
  seed: 42,
  command: 'train --epochs 2',
  conditions: { epochs: 2, backend: 'cpu' },
};
const points = [
  { step: 0, metric: 'policy' as const, name: 'entropy', value: 1.5 },
  { step: 1, metric: 'policy' as const, name: 'entropy', value: 1.0 },
  { step: 0, metric: 'value' as const, value: -0.25 },
  { step: 1, metric: 'value' as const, value: 0.5 },
  { step: 0, metric: 'reward' as const, value: 0 },
  { step: 1, metric: 'reward' as const, value: 1 },
];

describe('versioned training telemetry replay', () => {
  it('persists policy/value/reward and run/code/schema attribution', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-telemetry-'));
    const manifest = writeTelemetryArtifact(root, metadata, points);
    expect(manifest.schemaVersion).toBe(TELEMETRY_SCHEMA_VERSION);
    expect(manifest.generatorVersion).toBe(TELEMETRY_GENERATOR_VERSION);
    expect(manifest.metadata).toEqual(metadata);
    expect(fs.readFileSync(path.join(root, metadata.runId, 'metrics.jsonl'), 'utf8')).toContain(
      '"metric":"reward"'
    );
  });

  it('recreates byte-identical aggregate and native TensorBoard event artifacts from raw data', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-telemetry-'));
    writeTelemetryArtifact(root, metadata, points);
    const first = replayTelemetry(root, metadata.runId);
    const aggregateBytes = fs.readFileSync(first.aggregatePath);
    const eventBytes = fs.readFileSync(first.tensorBoardPath);
    fs.unlinkSync(first.aggregatePath);
    fs.unlinkSync(first.tensorBoardPath);
    const second = replayTelemetry(root, metadata.runId);
    expect(fs.readFileSync(second.aggregatePath)).toEqual(aggregateBytes);
    expect(fs.readFileSync(second.tensorBoardPath)).toEqual(eventBytes);
    expect(second.aggregate.series.map((series) => series.tag)).toEqual([
      'policy/entropy',
      'reward',
      'value',
    ]);
    expect(eventBytes.subarray(0, 8).readBigUInt64LE()).toBeGreaterThan(0n);
  });

  it('rejects unsupported schemas and raw artifact tampering', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-telemetry-'));
    writeTelemetryArtifact(root, metadata, points);
    const manifestFile = path.join(root, metadata.runId, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({ ...manifest, schemaVersion: 'ptcg-training-telemetry/v99' })
    );
    expect(() => replayTelemetry(root, metadata.runId)).toThrow('unsupported telemetry schema');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    fs.appendFileSync(path.join(root, metadata.runId, 'metrics.jsonl'), '{}\n');
    expect(() => replayTelemetry(root, metadata.runId)).toThrow(/size mismatch|checksum mismatch/);
  });
});
