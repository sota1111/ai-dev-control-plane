import { performance } from 'node:perf_hooks';
import path from 'node:path';
import process from 'node:process';
import {
  EVALUATION_PROTOCOL_VERSION,
  runEvaluation,
  type EvaluationProtocol,
} from './lib/ptcgEvaluationHarness.js';
import {
  STATISTICAL_BENCHMARK_SCHEMA,
  compareWithBaseline,
} from './lib/ptcgStatisticalBenchmark.js';
import { evaluateReleaseGate, writeReleaseGateArtifacts } from './lib/ptcgReleaseGate.js';

const mode = process.argv[2] === 'scheduled' ? 'scheduled' : 'smoke';
const output = path.resolve(process.argv[3] ?? 'artifacts/ptcg-release-gate');
const repetitions = mode === 'scheduled' ? 400 : 100;
const generatedAt = process.env.BENCHMARK_GENERATED_AT ?? new Date().toISOString();
const maximumDurationMs = Number(process.env.BENCHMARK_MAX_DURATION_MS ?? 10_000);
const protocol = (artifactId: string): EvaluationProtocol => ({
  protocolVersion: EVALUATION_PROTOCOL_VERSION,
  environmentVersion: 'fixture-engine/v1',
  baseSeed: 1786,
  repetitions,
  decks: [{ id: 'release-deck', contentHash: 'sha256:release-deck-v1' }],
  opponentPool: [{ snapshotId: 'release-opponent', artifactId: 'fixture:opponent-v1' }],
  methods: [{ id: 'candidate', artifactId }],
});
const runner = async (match: { seed: number }) => ({
  winner: (match.seed % 2 === 0 ? 'method' : 'opponent') as 'method' | 'opponent',
});

const baseline = await runEvaluation(protocol('git:baseline-v1'), { candidate: runner });
const started = performance.now();
const candidate = await runEvaluation(protocol('git:candidate'), { candidate: runner });
const durationMs = Math.round(performance.now() - started);
const benchmark = compareWithBaseline(
  candidate,
  {
    schemaVersion: STATISTICAL_BENCHMARK_SCHEMA,
    baselineVersion: 'release-v1',
    createdAt: '2026-07-20T00:00:00.000Z',
    run: baseline,
  },
  generatedAt,
  {
    confidenceLevel: 0.95,
    equivalenceMargin: mode === 'scheduled' ? 0.1 : 0.2,
    minimumGames: repetitions * 2,
  }
);
const report = evaluateReleaseGate({
  generatedAt,
  mode,
  benchmark,
  durationMs,
  maximumDurationMs,
  artifact: { benchmark, candidate },
});
const files = writeReleaseGateArtifacts(output, report);
console.log(`release gate ${report.passed ? 'PASS' : 'FAIL'} (${mode})`);
console.log(`artifacts: ${files.json}, ${files.markdown}`);
if (!report.passed) process.exitCode = 1;
