import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UME_CROSS_PLAY_OPPONENTS,
  UME_EVALUATION_SCHEMA,
  evaluateUmeGame,
  validateUmeAggressiveProfile,
  wilson95,
  type UmeAggressiveProfile,
  type UmeEvaluationGame,
} from './lib/ptcgUmeAggressive.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, process.argv[2] ?? 'artifacts/ptcg-ume-aggressive/sot-1850');
const profileFile = path.join(root, 'config', 'ptcg_ume_aggressive.json');
const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8')) as UmeAggressiveProfile;
const errors = validateUmeAggressiveProfile(profile);
if (errors.length) throw new Error(errors.join('; '));

fs.mkdirSync(output, { recursive: true });
const checkpointFile = path.join(output, 'checkpoint.json');
let games: UmeEvaluationGame[] = [];
if (fs.existsSync(checkpointFile)) {
  const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
  if (checkpoint.profileId === profile.archetype.id) games = checkpoint.games;
}
const seen = new Set(games.map((game) => game.id));
for (const opponent of ['baseline', ...UME_CROSS_PLAY_OPPONENTS] as const) {
  const variants =
    opponent === 'baseline' ? (['baseline', 'candidate'] as const) : (['candidate'] as const);
  for (const variant of variants)
    for (let offset = 0; offset < profile.exploration.seedCount; offset++) {
      for (const seat of ['first', 'second'] as const) {
        const game = evaluateUmeGame(
          profile,
          variant,
          opponent,
          profile.exploration.seedStart + offset,
          seat
        );
        if (!seen.has(game.id)) games.push(game);
        seen.add(game.id);
        if (games.length % profile.exploration.checkpointEvery === 0)
          fs.writeFileSync(
            checkpointFile,
            `${JSON.stringify({ schemaVersion: UME_EVALUATION_SCHEMA, profileId: profile.archetype.id, games }, null, 2)}\n`
          );
      }
    }
}
fs.writeFileSync(
  checkpointFile,
  `${JSON.stringify({ schemaVersion: UME_EVALUATION_SCHEMA, profileId: profile.archetype.id, games }, null, 2)}\n`
);

const summarize = (
  variant: UmeEvaluationGame['variant'],
  opponent: UmeEvaluationGame['opponent']
) => {
  const rows = games.filter((game) => game.variant === variant && game.opponent === opponent);
  const wins = rows.filter((game) => game.outcome === 'win').length;
  return {
    variant,
    opponent,
    games: rows.length,
    wins,
    losses: rows.length - wins,
    winRate: wins / rows.length,
    wilson95: wilson95(wins, rows.length),
  };
};
const results = [
  summarize('baseline', 'baseline'),
  summarize('candidate', 'baseline'),
  ...UME_CROSS_PLAY_OPPONENTS.map((opponent) => summarize('candidate', opponent)),
];
const report = {
  schemaVersion: UME_EVALUATION_SCHEMA,
  profile: path.relative(root, profileFile),
  sourceLeague: profile.sourceLeague,
  seeds: profile.exploration.seedCount,
  seatSwap: profile.exploration.seatSwap,
  results,
  safety: {
    faults: games.filter((game) => game.fault).length,
    unfinished: games.filter((game) => game.unfinished).length,
    illegalActions: games.filter((game) => game.illegalAction).length,
  },
};
fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
const markdown = [
  '# SOT-1850 Ume aggressive A/B',
  '',
  `Profile: \`${report.profile}\`; seeds: ${report.seeds}; seat swap: ${report.seatSwap}; games: ${games.length}.`,
  '',
  '| variant | opponent | W-L | win rate | Wilson 95% |',
  '| --- | --- | ---: | ---: | ---: |',
  ...results.map(
    (row) =>
      `| ${row.variant} | ${row.opponent} | ${row.wins}-${row.losses} | ${row.winRate.toFixed(3)} | ${row.wilson95.low.toFixed(3)}–${row.wilson95.high.toFixed(3)} |`
  ),
  '',
  `Fault / unfinished / illegal action: ${report.safety.faults} / ${report.safety.unfinished} / ${report.safety.illegalActions}.`,
  '',
  'The checkpoint contains every fixed-seed, seat-reversed game and may be reused to resume without duplication.',
  '',
].join('\n');
fs.writeFileSync(path.join(output, 'report.md'), markdown);
console.log(`ume evaluation completed: ${games.length} games`);
