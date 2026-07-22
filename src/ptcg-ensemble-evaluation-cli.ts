import fs from 'node:fs';
import path from 'node:path';
import { buildEnsembleReport, type EnsembleConfig } from './lib/ptcgEnsembleEvaluation.js';

const root = process.cwd();
const configPath = process.argv[2] ?? 'config/ptcg_ensemble_evaluation.json';
const outputDir = process.argv[3] ?? 'artifacts/ptcg-ensemble/sot-1851';
const config = JSON.parse(
  fs.readFileSync(path.resolve(root, configPath), 'utf8')
) as EnsembleConfig;
const inputs = config.agents.map((agent) => ({
  profile: JSON.parse(fs.readFileSync(path.resolve(root, agent.profile), 'utf8')),
  report: JSON.parse(fs.readFileSync(path.resolve(root, agent.report), 'utf8')),
  checkpointResumable: fs.existsSync(path.resolve(root, agent.checkpoint)),
}));
const report = buildEnsembleReport(config, inputs);
fs.mkdirSync(path.resolve(root, outputDir), { recursive: true });
fs.writeFileSync(
  path.resolve(root, outputDir, 'report.json'),
  `${JSON.stringify(report, null, 2)}\n`
);
const matrixHeader = `| Agent | ${config.opponents.join(' | ')} |`;
const matrixRows = Object.entries(report.matchupMatrix).map(
  ([agent, rates]) =>
    `| ${agent} | ${config.opponents.map((opponent) => rates[opponent].toFixed(3)).join(' | ')} |`
);
const markdown = `# 松竹梅 Ensemble Diversity / Non-regression Report\n\n- Verdict: **${report.verdict.pass ? 'PASS' : 'FAIL'}**\n- Profiles: ${report.diversity.uniqueDecks} decks / ${report.diversity.uniqueStrategies} strategies / ${report.diversity.uniqueRiskProfiles} risk profiles\n- Mean pairwise policy distance: ${report.diversity.meanPolicyDistance}\n- Cross-play: ${report.execution.totalCrossPlayGames} games, ${report.execution.seedsPerAgent} seeds, seat swap=${report.execution.seatSwap}\n- Resume checkpoints: ${report.execution.resumableCheckpoints}/3; budget <= ${report.execution.budgetHours}h per source run\n\n## Matchup matrix (candidate win rate)\n\n${matrixHeader}\n| --- | ${config.opponents.map(() => '---:').join(' | ')} |\n${matrixRows.join('\n')}\n\n## Safety\n\n- faults: ${report.safety.faults}\n- unfinished: ${report.safety.unfinished}\n- illegal actions: ${report.safety.illegalActions}\n`;
fs.writeFileSync(path.resolve(root, outputDir, 'report.md'), markdown);
console.log(
  `ensemble evaluation ${report.verdict.pass ? 'PASS' : 'FAIL'}: ${outputDir}/report.json`
);
if (!report.verdict.pass) process.exitCode = 1;
