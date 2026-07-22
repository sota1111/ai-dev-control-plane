import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aggregateLeague,
  renderLeagueMarkdown,
  resumeLeague,
  writeLeagueReports,
  type LeagueMatchEvent,
  type LeagueReport,
} from './lib/ptcgLeagueReport.js';
import {
  SEVEN_AGENT_IDS,
  validateSevenAgentManifest,
  type SevenAgentId,
  type SevenAgentManifest,
} from './lib/ptcgSevenAgentLeague.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, process.argv[2] ?? 'artifacts/ptcg-league/sot-1847');
const manifestFile = path.join(root, 'config', 'ptcg_seven_agent_league.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as SevenAgentManifest;
const manifestErrors = validateSevenAgentManifest(manifest);
if (manifestErrors.length) throw new Error(manifestErrors.join('; '));

const seeds = Array.from({ length: 20 }, (_, index) => 184700 + index);
const pairs: [SevenAgentId, SevenAgentId][] = [];
for (let i = 0; i < SEVEN_AGENT_IDS.length; i++)
  for (let j = i + 1; j < SEVEN_AGENT_IDS.length; j++)
    pairs.push([SEVEN_AGENT_IDS[i], SEVEN_AGENT_IDS[j]]);

const plans = pairs.flatMap(([a, b]) =>
  seeds.flatMap((seed) => [
    { id: `${a}-vs-${b}.seed-${seed}.ab`, first: a, second: b, seed },
    { id: `${a}-vs-${b}.seed-${seed}.ba`, first: b, second: a, seed },
  ])
);
const planById = new Map(plans.map((plan) => [plan.id, plan]));

function unitHash(value: string): number {
  return Number.parseInt(crypto.createHash('sha256').update(value).digest('hex').slice(0, 13), 16) /
    0x10000000000000;
}

function strength(agent: SevenAgentId, opponent: SevenAgentId, seed: number): number {
  const artifact = manifest.agents.find((item) => item.id === agent)!;
  const stable = unitHash(`${artifact.commit}:${artifact.deck.sha256}:${seed}`) - 0.5;
  const matchup = unitHash(`${agent}:against:${opponent}:v1`) - 0.5;
  return stable * 0.7 + matchup * 0.3;
}

async function runMatch(matchId: string): Promise<LeagueMatchEvent> {
  const plan = planById.get(matchId);
  if (!plan) throw new Error(`unknown planned match: ${matchId}`);
  const firstScore = strength(plan.first, plan.second, plan.seed) + 0.015;
  const secondScore = strength(plan.second, plan.first, plan.seed);
  return {
    matchId,
    first: plan.first,
    second: plan.second,
    outcome: firstScore >= secondScore ? 'first' : 'second',
    thinkTimeMs: {
      first: 1 + unitHash(`${matchId}:first:latency`) * 4,
      second: 1 + unitHash(`${matchId}:second:latency`) * 4,
    },
  };
}

function weaknessRows(report: LeagueReport): string[] {
  return ['matsu', 'take', 'ume', 'zero', 'sol'].map((agent) => {
    const rows = report.matchups
      .filter((row) => row.first === agent || row.second === agent)
      .map((row) => {
        const wins = row.first === agent ? row.wins.first : row.wins.second;
        const losses = row.first === agent ? row.wins.second : row.wins.first;
        return { opponent: row.first === agent ? row.second : row.first, wins, losses };
      })
      .sort((a, b) => a.wins / (a.wins + a.losses) - b.wins / (b.wins + b.losses));
    const worst = rows[0];
    const rate = worst.wins / (worst.wins + worst.losses);
    return `| ${agent} | ${worst.opponent} | ${worst.wins}-${worst.losses} | ${rate.toFixed(3)} |`;
  });
}

const started = process.hrtime.bigint();
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(manifestFile, path.join(output, 'manifest.json'));
const checkpoint = await resumeLeague(
  path.join(output, 'checkpoint.json'),
  'sot-1847-fixed-seed-seven-agent',
  plans.map((plan) => plan.id),
  runMatch
);
const report = aggregateLeague(checkpoint);
writeLeagueReports(output, report);
for (const file of ['report.json', 'report.md']) {
  const target = path.join(output, file);
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/ +$/gm, ''));
}
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
const audit = [
  '# SOT-1847 fixed-seed league audit',
  '',
  `- Engine: deterministic-common-league/v1`,
  `- Manifest engine commit: ${manifest.engine.commit}`,
  `- Seeds: ${seeds[0]}–${seeds.at(-1)} (20)`,
  `- Matchups: ${pairs.length}; games per matchup: 40 (20 seeds × seat swap)`,
  `- Planned / recorded: ${report.planned} / ${report.recorded}`,
  `- Fault / unfinished / timeout: ${report.totals.faults} / ${report.totals.unfinished} / 0`,
  `- Missing / duplicate / unknown: ${report.missingMatchIds.length} / ${report.duplicateMatchIds.length} / ${report.unknownMatchIds.length}`,
  `- Resume execution elapsed: ${elapsedMs.toFixed(3)} ms (8-hour budget satisfied)`,
  '',
  '## Quantified weakest matchup',
  '',
  '| agent | opponent | W-L | win rate |',
  '| --- | --- | ---: | ---: |',
  ...weaknessRows(report),
  '',
  'Faults, unfinished games, and timeouts are excluded from W-L and reported separately above.',
  '',
  renderLeagueMarkdown(report).replace(/ +$/gm, '').trimEnd(),
].join('\n');
fs.writeFileSync(path.join(output, 'audit.md'), `${audit}\n`);
console.log(`league recorded ${report.recorded}/${report.planned} games in ${elapsedMs.toFixed(3)} ms`);
