import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aggregateLeague,
  resumeLeague,
  writeLeagueReports,
  type LeagueReport,
} from './lib/ptcgLeagueReport.js';
import {
  budgetedMatchCount,
  buildRepresentativeRuntimePlan,
  buildRuntimeAudit,
  parseRuntimeLeagueManifest,
  runRealRuntimeMatch,
  writeRuntimeAudit,
} from './lib/ptcgRealRuntimeLeague.js';
import { resolveSevenAgentManifest } from './lib/ptcgSevenAgentLeague.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};
const output = path.resolve(root, value('--output', 'artifacts/ptcg-league/sot-1880-runtime'));
const siblingsRoot = path.resolve(value('--siblings-root', path.dirname(root)));
const planFile = path.resolve(root, value('--plan', 'config/ptcg_real_runtime_league.json'));
const runtimePlan = parseRuntimeLeagueManifest(JSON.parse(fs.readFileSync(planFile, 'utf8')));
const timeoutMs = Number(value('--timeout-ms', String(runtimePlan.timeoutMs)));
const budgetHours = Number(value('--budget-hours', String(runtimePlan.budgetHours)));
const engineCommit = execFileSync(
  'git',
  ['-C', path.join(siblingsRoot, 'ptcg-agent-sol'), 'rev-parse', 'HEAD'],
  { encoding: 'utf8' }
).trim();
const manifest = resolveSevenAgentManifest(siblingsRoot, engineCommit);
const plans = buildRepresentativeRuntimePlan(runtimePlan.seeds, {
  priorityMatchups: runtimePlan.priorityMatchups,
  maxMatches: budgetedMatchCount({ ...runtimePlan, budgetHours }),
});
const plansById = new Map(plans.map((plan) => [plan.id, plan]));
const started = Date.now();
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(
  path.join(output, 'manifest.json'),
  `${JSON.stringify({ ...manifest, runtimeLeague: { ...runtimePlan, timeoutMs, budgetHours, plannedMatches: plans.length } }, null, 2)}\n`
);
const checkpointFile = path.join(output, 'checkpoint.json');
const checkpoint = await resumeLeague(
  checkpointFile,
  runtimePlan.leagueId,
  plans.map((plan) => plan.id),
  async (matchId) => {
    const plan = plansById.get(matchId);
    if (!plan) throw new Error(`unknown match: ${matchId}`);
    return runRealRuntimeMatch({ root, siblingsRoot, manifest, plan, timeoutMs });
  }
);
const runtime = aggregateLeague(checkpoint);
writeLeagueReports(output, runtime);
for (const file of ['report.json', 'report.md']) {
  const target = path.join(output, file);
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/ +$/gm, ''));
}
const synthetic = JSON.parse(
  fs.readFileSync(path.join(root, 'artifacts', 'ptcg-league', 'sot-1847', 'report.json'), 'utf8')
) as LeagueReport;
const measuredElapsedMs = checkpoint.events.reduce(
  (total, event) =>
    total +
    (event.durationMs ??
      (event.thinkTimeMs ? event.thinkTimeMs.first + event.thinkTimeMs.second : 0)),
  0
);
const audit = buildRuntimeAudit({
  runtime,
  synthetic,
  seeds: runtimePlan.seeds,
  timeoutMs,
  budgetHours,
  elapsedMs: measuredElapsedMs,
  events: checkpoint.events,
});
writeRuntimeAudit(output, audit);
if (
  audit.execution.elapsedMs > budgetHours * 60 * 60 * 1000 ||
  Date.now() - started > budgetHours * 60 * 60 * 1000
)
  throw new Error('runtime budget exceeded');
console.log(
  `real runtime league ${runtime.recorded}/${runtime.planned}; faults=${audit.execution.faults}; unfinished=${audit.execution.unfinished}`
);
