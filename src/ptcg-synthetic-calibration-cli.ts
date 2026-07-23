import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LeagueCheckpoint, LeagueReport } from './lib/ptcgLeagueReport.js';
import {
  buildSyntheticCalibration,
  writeSyntheticCalibration,
} from './lib/ptcgSyntheticCalibration.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};
const syntheticPath = value('--synthetic', 'artifacts/ptcg-league/sot-1847/report.json');
const checkpointPath = value(
  '--runtime-checkpoint',
  'artifacts/ptcg-league/sot-1880-runtime/checkpoint.json'
);
const output = path.resolve(root, value('--output', 'artifacts/ptcg-league/sot-1881-calibration'));
const synthetic = JSON.parse(
  fs.readFileSync(path.resolve(root, syntheticPath), 'utf8')
) as LeagueReport;
const checkpoint = JSON.parse(
  fs.readFileSync(path.resolve(root, checkpointPath), 'utf8')
) as LeagueCheckpoint;
const report = buildSyntheticCalibration({
  checkpoint,
  synthetic,
  syntheticPath,
  checkpointPath,
});
writeSyntheticCalibration(output, report);
console.log(
  `synthetic calibration holdout MAE ${report.holdout.before.mae} -> ${report.holdout.after.mae}; ` +
    `max ${report.holdout.before.maximumAbsoluteDifference} -> ${report.holdout.after.maximumAbsoluteDifference}`
);
if (!report.holdout.improved) throw new Error('calibration did not improve untouched holdout');
