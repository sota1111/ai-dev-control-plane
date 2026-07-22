import fs from 'node:fs';
import path from 'node:path';
import { buildEnsembleReport, type EnsembleConfig } from '../lib/ptcgEnsembleEvaluation.js';

const root = process.cwd();
const config = JSON.parse(
  fs.readFileSync(path.join(root, 'config/ptcg_ensemble_evaluation.json'), 'utf8')
) as EnsembleConfig;
const inputs = config.agents.map((agent) => ({
  profile: JSON.parse(fs.readFileSync(path.join(root, agent.profile), 'utf8')),
  report: JSON.parse(fs.readFileSync(path.join(root, agent.report), 'utf8')),
  checkpointResumable: fs.existsSync(path.join(root, agent.checkpoint)),
}));

describe('松竹梅 ensemble evaluation', () => {
  const report = buildEnsembleReport(config, inputs);

  test('quantifies three distinct deck, strategy, and risk profiles', () => {
    expect(report.diversity.uniqueDecks).toBe(3);
    expect(report.diversity.uniqueStrategies).toBe(3);
    expect(report.diversity.uniqueRiskProfiles).toBe(3);
    expect(
      Object.values(report.diversity.pairwisePolicyDistance).every((distance) => distance > 0)
    ).toBe(true);
  });

  test('integrates seat-reversed cross-play against four heterogeneous agents', () => {
    expect(Object.keys(report.ensembleByOpponent)).toEqual(['sol', 'debate', 'fable', 'zero']);
    expect(report.execution.totalCrossPlayGames).toBe(480);
    expect(report.execution.seatSwap).toBe(true);
    expect(report.execution.resumableCheckpoints).toBe(3);
  });

  test('finds no major matchup regression or safety failure', () => {
    expect(Object.values(report.ensembleByOpponent).every((row) => !row.regression)).toBe(true);
    expect(Object.values(report.individualAB).every((row) => row.delta > 0)).toBe(true);
    expect(report.safety).toEqual({ faults: 0, unfinished: 0, illegalActions: 0 });
    expect(report.verdict).toEqual({
      diverse: true,
      noMajorRegression: true,
      safe: true,
      pass: true,
    });
  });
});
