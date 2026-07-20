import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EVALUATION_PROTOCOL_VERSION,
  runEvaluation,
  type EvaluationRun,
} from '../lib/ptcgEvaluationHarness.js';
import {
  STATISTICAL_BENCHMARK_SCHEMA,
  compareWithBaseline,
  writeBenchmarkReport,
  type VersionedBenchmarkBaseline,
} from '../lib/ptcgStatisticalBenchmark.js';

const generatedAt = '2026-07-20T00:00:00.000Z';
async function evaluation(wins: number, games = 400): Promise<EvaluationRun> {
  let seen = 0;
  return runEvaluation(
    {
      protocolVersion: EVALUATION_PROTOCOL_VERSION,
      environmentVersion: 'engine@fixed',
      baseSeed: 1783,
      repetitions: games / 2,
      decks: [{ id: 'fixed-deck', contentHash: 'sha256:deck' }],
      opponentPool: [{ snapshotId: 'fixed-pool', artifactId: 'model:pool-v1' }],
      methods: [{ id: 'method', artifactId: `git:${wins}` }],
    },
    { method: async () => ({ winner: seen++ < wins ? 'method' : 'opponent' }) }
  );
}
async function comparison(candidateWins: number, baselineWins: number) {
  const baseline: VersionedBenchmarkBaseline = {
    schemaVersion: STATISTICAL_BENCHMARK_SCHEMA,
    baselineVersion: '2026.07.1',
    createdAt: generatedAt,
    run: await evaluation(baselineWins),
  };
  return compareWithBaseline(await evaluation(candidateWins), baseline, generatedAt, {
    confidenceLevel: 0.95,
    equivalenceMargin: 0.1,
    minimumGames: 100,
  });
}

describe('statistical benchmark baseline decisions', () => {
  it.each([
    [300, 200, 'improved', true],
    [200, 200, 'equivalent', true],
    [100, 200, 'regressed', false],
  ] as const)(
    'classifies candidate=%i baseline=%i as %s',
    async (candidate, baseline, classification, passed) => {
      const result = (await comparison(candidate, baseline)).results[0];
      expect(result).toMatchObject({ classification, passed });
      expect(result.confidenceInterval95.method).toBe('newcombe-wilson');
    }
  );

  it('rejects mismatched fixed conditions and insufficient trials', async () => {
    const baseRun = await evaluation(20, 40);
    const baseline: VersionedBenchmarkBaseline = {
      schemaVersion: STATISTICAL_BENCHMARK_SCHEMA,
      baselineVersion: 'v1',
      createdAt: generatedAt,
      run: baseRun,
    };
    const small = compareWithBaseline(await evaluation(20, 40), baseline, generatedAt, {
      confidenceLevel: 0.95,
      equivalenceMargin: 0.1,
      minimumGames: 100,
    });
    expect(small.results[0].classification).toBe('inconclusive');
    const changed = await evaluation(20, 40);
    changed.protocol.baseSeed++;
    expect(() => compareWithBaseline(changed, baseline, generatedAt)).toThrow('conditions differ');
  });

  it('writes byte-reproducible versioned JSON for scheduled retention', async () => {
    const report = await comparison(200, 200);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-'));
    const first = path.join(dir, 'first.json');
    const second = path.join(dir, 'second.json');
    writeBenchmarkReport(first, report);
    writeBenchmarkReport(second, report);
    expect(fs.readFileSync(second)).toEqual(fs.readFileSync(first));
    expect(JSON.parse(fs.readFileSync(first, 'utf8'))).toMatchObject({
      schemaVersion: STATISTICAL_BENCHMARK_SCHEMA,
      baselineVersion: '2026.07.1',
      generatedAt,
    });
  });
});
