import fs from 'node:fs';
import path from 'node:path';
import type { LeagueCheckpoint, LeagueMatchEvent, LeagueReport } from './ptcgLeagueReport.js';

export const SYNTHETIC_CALIBRATION_SCHEMA = 'ptcg-synthetic-runtime-calibration/v1' as const;

type Observation = {
  first: string;
  second: string;
  seed: number;
  runtimeFirstWin: number;
  syntheticFirstWinRate: number;
};

export interface CalibrationMetrics {
  matchupCount: number;
  mae: number;
  maximumAbsoluteDifference: number;
  rankingAgreement: number;
  ranking: string[];
}

export interface SyntheticCalibrationReport {
  schemaVersion: typeof SYNTHETIC_CALIBRATION_SCHEMA;
  source: { synthetic: string; runtimeCheckpoint: string };
  split: {
    trainingSeeds: number[];
    holdoutSeeds: number[];
    trainingEvents: number;
    holdoutEvents: number;
  };
  model: { kind: 'ridge-agent-bias'; ridge: number; agentBias: Record<string, number> };
  training: { before: CalibrationMetrics; after: CalibrationMetrics };
  holdout: { before: CalibrationMetrics; after: CalibrationMetrics; improved: boolean };
  matchupAnalysis: Array<{
    matchup: string;
    sampleSize: number;
    runtimeFirstWinRate: number;
    syntheticFirstWinRate: number;
    calibratedFirstWinRate: number;
    beforeAbsoluteDifference: number;
    afterAbsoluteDifference: number;
    factorHypothesis: string;
  }>;
  reinforcementPriority: Array<{
    rank: number;
    agent: string;
    runtimeScore: number;
    calibratedScore: number;
    remainingGap: number;
  }>;
}

const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const round = (value: number): number => Number(value.toFixed(6));
const seedOf = (event: LeagueMatchEvent): number => {
  const match = /\.seed-(\d+)\./.exec(event.matchId);
  if (!match) throw new Error(`runtime event lacks seed: ${event.matchId}`);
  return Number(match[1]);
};

function observations(checkpoint: LeagueCheckpoint, synthetic: LeagueReport): Observation[] {
  const rates = new Map(
    synthetic.matchups.map((row) => [`${row.first}\0${row.second}`, row.firstWinRate])
  );
  return checkpoint.events.flatMap((event) => {
    if (event.outcome !== 'first' && event.outcome !== 'second') return [];
    const [first, second] = [event.first, event.second].sort();
    const direct = event.first === first;
    const rate = rates.get(`${first}\0${second}`);
    if (rate === undefined || rate === null)
      throw new Error(`synthetic matchup missing decided rate: ${first} vs ${second}`);
    const firstWon = event.outcome === (direct ? 'first' : 'second');
    return [
      {
        first,
        second,
        seed: seedOf(event),
        runtimeFirstWin: firstWon ? 1 : 0,
        syntheticFirstWinRate: rate,
      },
    ];
  });
}

function solve(matrix: number[][], vector: number[]): number[] {
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < rows.length; column++) {
    let pivot = column;
    for (let row = column + 1; row < rows.length; row++)
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    if (Math.abs(rows[column][column]) < 1e-12) continue;
    const divisor = rows[column][column];
    for (let index = column; index <= rows.length; index++) rows[column][index] /= divisor;
    for (let row = 0; row < rows.length; row++) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let index = column; index <= rows.length; index++)
        rows[row][index] -= factor * rows[column][index];
    }
  }
  return rows.map((row, index) => row[rows.length] ?? (index === 0 ? 0 : 0));
}

function fit(rows: Observation[], agents: string[], ridge: number): Record<string, number> {
  const dimension = agents.length;
  const normal = Array.from({ length: dimension }, () => Array(dimension).fill(0) as number[]);
  const target = Array(dimension).fill(0) as number[];
  for (const row of rows) {
    const features = agents.map((agent) =>
      agent === row.first ? 1 : agent === row.second ? -1 : 0
    );
    const residual = row.runtimeFirstWin - row.syntheticFirstWinRate;
    for (let i = 0; i < dimension; i++) {
      target[i] += features[i] * residual;
      for (let j = 0; j < dimension; j++) normal[i][j] += features[i] * features[j];
    }
  }
  for (let index = 0; index < dimension; index++) normal[index][index] += ridge;
  const solution = solve(normal, target);
  return Object.fromEntries(agents.map((agent, index) => [agent, solution[index]]));
}

const prediction = (row: Observation, bias: Record<string, number>): number =>
  clamp(row.syntheticFirstWinRate + (bias[row.first] ?? 0) - (bias[row.second] ?? 0));

// eslint-disable-next-line no-unused-vars
function aggregate(rows: Observation[], predict: (observation: Observation) => number) {
  const grouped = new Map<
    string,
    { first: string; second: string; actual: number[]; predicted: number[] }
  >();
  for (const row of rows) {
    const key = `${row.first}\0${row.second}`;
    const group = grouped.get(key) ?? {
      first: row.first,
      second: row.second,
      actual: [],
      predicted: [],
    };
    group.actual.push(row.runtimeFirstWin);
    group.predicted.push(predict(row));
    grouped.set(key, group);
  }
  return [...grouped.values()].map((group) => ({
    ...group,
    runtime: group.actual.reduce((sum, value) => sum + value, 0) / group.actual.length,
    predicted: group.predicted.reduce((sum, value) => sum + value, 0) / group.predicted.length,
  }));
}

function scores(
  groups: ReturnType<typeof aggregate>,
  field: 'runtime' | 'predicted'
): Record<string, number> {
  const values = new Map<string, number[]>();
  for (const row of groups) {
    (values.get(row.first) ?? values.set(row.first, []).get(row.first)!).push(row[field]);
    (values.get(row.second) ?? values.set(row.second, []).get(row.second)!).push(1 - row[field]);
  }
  return Object.fromEntries(
    [...values].map(([agent, rates]) => [agent, rates.reduce((a, b) => a + b, 0) / rates.length])
  );
}

function metrics(
  rows: Observation[],
  // eslint-disable-next-line no-unused-vars
  predict: (observation: Observation) => number
): CalibrationMetrics {
  const groups = aggregate(rows, predict);
  const differences = groups.map((row) => Math.abs(row.runtime - row.predicted));
  const runtimeScores = scores(groups, 'runtime');
  const predictedScores = scores(groups, 'predicted');
  const agents = Object.keys(runtimeScores).sort();
  let agreed = 0;
  let compared = 0;
  for (let i = 0; i < agents.length; i++)
    for (let j = i + 1; j < agents.length; j++) {
      const actual = Math.sign(runtimeScores[agents[i]] - runtimeScores[agents[j]]);
      const expected = Math.sign(predictedScores[agents[i]] - predictedScores[agents[j]]);
      if (actual === 0 || expected === 0) continue;
      compared++;
      if (actual === expected) agreed++;
    }
  return {
    matchupCount: groups.length,
    mae: round(differences.reduce((a, b) => a + b, 0) / differences.length),
    maximumAbsoluteDifference: round(Math.max(...differences)),
    rankingAgreement: round(compared ? agreed / compared : 1),
    ranking: agents.sort((a, b) => predictedScores[b] - predictedScores[a]),
  };
}

export function buildSyntheticCalibration(options: {
  checkpoint: LeagueCheckpoint;
  synthetic: LeagueReport;
  syntheticPath: string;
  checkpointPath: string;
}): SyntheticCalibrationReport {
  const all = observations(options.checkpoint, options.synthetic);
  const seeds = [...new Set(all.map((row) => row.seed))].sort((a, b) => a - b);
  if (seeds.length < 2) throw new Error('calibration requires at least two runtime seeds');
  const holdoutSeeds = [seeds.at(-1)!];
  const trainingSeeds = seeds.slice(0, -1);
  const training = all.filter((row) => trainingSeeds.includes(row.seed));
  const holdout = all.filter((row) => holdoutSeeds.includes(row.seed));
  if (!holdout.length) throw new Error('holdout seed contains no decided runtime events');
  const agents = [...new Set(all.flatMap((row) => [row.first, row.second]))].sort();
  const ridge = 12;
  const bias = fit(training, agents, ridge);
  const raw = (row: Observation) => row.syntheticFirstWinRate;
  const calibrated = (row: Observation) => prediction(row, bias);
  const holdoutBefore = metrics(holdout, raw);
  const holdoutAfter = metrics(holdout, calibrated);
  const trainingGroups = aggregate(training, calibrated);
  const analysis = trainingGroups
    .map((row) => {
      const syntheticRate = training.find(
        (item) => item.first === row.first && item.second === row.second
      )!.syntheticFirstWinRate;
      const before = Math.abs(row.runtime - syntheticRate);
      const after = Math.abs(row.runtime - row.predicted);
      const firstBias = bias[row.first];
      const secondBias = bias[row.second];
      return {
        matchup: `${row.first} vs ${row.second}`,
        sampleSize: row.actual.length,
        runtimeFirstWinRate: round(row.runtime),
        syntheticFirstWinRate: round(syntheticRate),
        calibratedFirstWinRate: round(row.predicted),
        beforeAbsoluteDifference: round(before),
        afterAbsoluteDifference: round(after),
        factorHypothesis:
          Math.abs(firstBias - secondBias) < 0.03
            ? 'agent-level bias is small; matchup interaction or runtime sampling is the leading hypothesis'
            : `${firstBias > secondBias ? row.first : row.second} is systematically stronger in real runtime than synthetic evaluation predicts`,
      };
    })
    .sort((a, b) => b.beforeAbsoluteDifference - a.beforeAbsoluteDifference);
  const fullGroups = aggregate(all, calibrated);
  const runtimeScores = scores(fullGroups, 'runtime');
  const calibratedScores = scores(fullGroups, 'predicted');
  const priority = agents
    .map((agent) => ({
      agent,
      runtimeScore: round(runtimeScores[agent]),
      calibratedScore: round(calibratedScores[agent]),
      remainingGap: round(runtimeScores[agent] - calibratedScores[agent]),
    }))
    .sort((a, b) => a.remainingGap - b.remainingGap)
    .map((row, index) => ({ rank: index + 1, ...row }));
  return {
    schemaVersion: SYNTHETIC_CALIBRATION_SCHEMA,
    source: { synthetic: options.syntheticPath, runtimeCheckpoint: options.checkpointPath },
    split: {
      trainingSeeds,
      holdoutSeeds,
      trainingEvents: training.length,
      holdoutEvents: holdout.length,
    },
    model: {
      kind: 'ridge-agent-bias',
      ridge,
      agentBias: Object.fromEntries(
        Object.entries(bias).map(([agent, value]) => [agent, round(value)])
      ),
    },
    training: { before: metrics(training, raw), after: metrics(training, calibrated) },
    holdout: {
      before: holdoutBefore,
      after: holdoutAfter,
      improved:
        holdoutAfter.mae <= holdoutBefore.mae &&
        holdoutAfter.maximumAbsoluteDifference <= holdoutBefore.maximumAbsoluteDifference,
    },
    matchupAnalysis: analysis,
    reinforcementPriority: priority,
  };
}

export function renderSyntheticCalibration(report: SyntheticCalibrationReport): string {
  const lines = [
    '# Synthetic league calibration against real runtime',
    '',
    `- Training seeds: ${report.split.trainingSeeds.join(', ')}`,
    `- Holdout seeds: ${report.split.holdoutSeeds.join(', ')} (never used to fit agent bias)`,
    `- Model: ${report.model.kind}, ridge=${report.model.ridge}`,
    '',
    '## Calibration metrics',
    '',
    '| split | metric | before | after |',
    '| --- | --- | ---: | ---: |',
    `| training | MAE | ${report.training.before.mae} | ${report.training.after.mae} |`,
    `| training | max absolute difference | ${report.training.before.maximumAbsoluteDifference} | ${report.training.after.maximumAbsoluteDifference} |`,
    `| training | ranking agreement | ${report.training.before.rankingAgreement} | ${report.training.after.rankingAgreement} |`,
    `| holdout | MAE | ${report.holdout.before.mae} | ${report.holdout.after.mae} |`,
    `| holdout | max absolute difference | ${report.holdout.before.maximumAbsoluteDifference} | ${report.holdout.after.maximumAbsoluteDifference} |`,
    `| holdout | ranking agreement | ${report.holdout.before.rankingAgreement} | ${report.holdout.after.rankingAgreement} |`,
    '',
    `Holdout calibration result: **${report.holdout.improved ? 'PASS' : 'FAIL'}**`,
    '',
    '## Matchup error hypotheses',
    '',
    '| matchup | n | runtime | synthetic | calibrated | abs error before → after | hypothesis |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ...report.matchupAnalysis.map(
      (row) =>
        `| ${row.matchup} | ${row.sampleSize} | ${row.runtimeFirstWinRate} | ${row.syntheticFirstWinRate} | ${row.calibratedFirstWinRate} | ${row.beforeAbsoluteDifference} → ${row.afterAbsoluteDifference} | ${row.factorHypothesis} |`
    ),
    '',
    '## Reinforcement priority',
    '',
    'Most negative remaining runtime-minus-calibrated score is the first reinforcement target.',
    '',
    '| rank | agent | runtime score | calibrated score | remaining gap |',
    '| ---: | --- | ---: | ---: | ---: |',
    ...report.reinforcementPriority.map(
      (row) =>
        `| ${row.rank} | ${row.agent} | ${row.runtimeScore} | ${row.calibratedScore} | ${row.remainingGap} |`
    ),
    '',
    '## Reproduction',
    '',
    '```bash',
    'npx tsx src/ptcg-synthetic-calibration-cli.ts',
    '```',
    '',
  ];
  return lines.join('\n');
}

export function writeSyntheticCalibration(
  directory: string,
  report: SyntheticCalibrationReport
): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'calibration.json'),
    `${JSON.stringify(report, null, 2)}\n`
  );
  fs.writeFileSync(path.join(directory, 'calibration.md'), renderSyntheticCalibration(report));
}
