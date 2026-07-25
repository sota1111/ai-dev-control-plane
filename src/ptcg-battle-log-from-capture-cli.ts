#!/usr/bin/env tsx
/**
 * Convert a cabt-engine board capture (scripts/ptcg_capture_battle.py) into a
 * `ptcg-battle-log/v1` file that the SOT-1907 timeline viewer can open.
 *
 * Usage:
 *   npx tsx src/ptcg-battle-log-from-capture-cli.ts <capture.json> [out.json] \
 *     [--battle-id <id>] [--names take,obo]
 *
 * The produced log is validated with `replayBattleLog` before it is written; the
 * command prints the snapshot count so viewer-readability is confirmed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { replayBattleLog } from './lib/ptcgBattleLogReplay.js';
import { convertCaptureToBattleLog, type BattleCapture } from './lib/ptcgObservationToBattleLog.js';

function parseArgs(argv: string[]): {
  input: string;
  output: string;
  battleId?: string;
  names?: [string, string];
} {
  const positional: string[] = [];
  let battleId: string | undefined;
  let names: [string, string] | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--battle-id') {
      battleId = argv[(i += 1)];
    } else if (arg === '--names') {
      const parts = (argv[(i += 1)] ?? '').split(',');
      if (parts.length !== 2) throw new Error('--names expects "first,second"');
      names = [parts[0].trim(), parts[1].trim()];
    } else {
      positional.push(arg);
    }
  }
  if (positional.length === 0) throw new Error('capture input path is required');
  const input = positional[0];
  const output = positional[1] ?? input.replace(/(\.capture)?\.json$/i, '') + '.battle-log.json';
  return { input, output, battleId, names };
}

function main(): void {
  const { input, output, battleId, names } = parseArgs(process.argv.slice(2));
  const capture = JSON.parse(readFileSync(input, 'utf8')) as BattleCapture;
  const log = convertCaptureToBattleLog(capture, { battleId, playerNames: names });
  const snapshots = replayBattleLog(log);
  writeFileSync(output, JSON.stringify(log, null, 2) + '\n', 'utf8');
  process.stdout.write(
    JSON.stringify({
      output,
      battleId: log.battleId,
      events: log.events.length,
      snapshots: snapshots.length,
      winner: snapshots[snapshots.length - 1].state.winner,
    }) + '\n'
  );
}

main();
