// SOT-1713: ptcg-battle-lab CLI — the SINGLE entrypoint for the 松竹梅 seat-swap round-robin.
//
// One command runs (or resumes) the whole round-robin and writes a redacted, checksum-referenced
// artifact set:
//
//   tsx src/ptcg-battle-lab-cli.ts run --run-id 20260718 --matches 40 --seed 20260718
//   tsx src/ptcg-battle-lab-cli.ts run --run-id 20260718            # re-invoke to RESUME (skips done shards)
//   tsx src/ptcg-battle-lab-cli.ts status --run-id 20260718
//   tsx src/ptcg-battle-lab-cli.ts preflight
//
// The actual match execution is behind `--runner`:
//   - fixture (default): a deterministic seeded stand-in so the pipeline is fully runnable/verifiable in
//     the control-plane and CI without the cabt engine.
//   - python: shells to matsu's eval/battle_matsu_take_ume.py (needs the engine + sibling checkouts).
//
// All orchestration/resume/atomicity/schema/redaction logic lives in src/lib/ptcgBattleLab.ts.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTESTANTS,
  LocalObjectStore,
  loadManifest,
  runRoundRobin,
  sha256Hex,
  type ContestantInput,
  type GameRecord,
  type RunConfig,
  type ShardRunner,
  type ShardSpec,
} from './lib/ptcgBattleLab.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONTROL_PLANE_ROOT = path.resolve(__dirname, '..');

interface Args {
  [key: string]: string | undefined;
}

function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const cmd = argv[0] ?? 'help';
  const args: Args = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = 'true';
      }
    }
  }
  return { cmd, args };
}

/** Resolve the git commit SHA of a repo, or 'unknown' if not a git repo / git absent. */
function repoCommit(repoDir: string): string {
  try {
    return execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** sha256 of a repo's deck.csv content (empty-string hash if absent) — a content hash, never a path. */
function deckHash(repoDir: string): string {
  const p = path.join(repoDir, 'deck.csv');
  try {
    return sha256Hex(fs.readFileSync(p));
  } catch {
    return sha256Hex('');
  }
}

/** Build the pinned per-contestant inputs from the sibling checkouts. */
function resolveInputs(siblingsRoot: string): ContestantInput[] {
  return CONTESTANTS.map((c) => {
    const repoDir = path.join(siblingsRoot, c.repo);
    return {
      label: c.label,
      kanji: c.kanji,
      repo: c.repo, // repo NAME only — no host path in the artifact
      commit: repoCommit(repoDir),
      deckHash: deckHash(repoDir),
    };
  });
}

/**
 * Deterministic fixture runner. Uses a seeded LCG (no Math.random) so a run is byte-reproducible and the
 * pipeline is exercisable without the engine. Seat 0 wins with a fixed per-pair bias; every ~17th match
 * is charged as a fault to the loser to exercise the fault-accounting path.
 */
const fixtureRunner: ShardRunner = async (shard: ShardSpec) => {
  let state = (shard.seed >>> 0) || 1;
  const next = (): number => {
    // Numerical Recipes LCG.
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const games: GameRecord[] = [];
  for (let i = 0; i < shard.matches; i++) {
    const seat0Wins = next() < 0.5 + biasFor(shard.seat0) - biasFor(shard.seat1);
    const winner = seat0Wins ? shard.seat0 : shard.seat1;
    const fault = i % 17 === 16;
    games.push({
      shardId: shard.shardId,
      matchIndex: i,
      seat0: shard.seat0,
      seat1: shard.seat1,
      winner,
      fault,
    });
  }
  return { games };
};

/** Fixed illustrative strength bias by contestant (fixture only; not a claim about real strength). */
function biasFor(label: string): number {
  return { matsu: 0.15, take: 0.0, ume: -0.1 }[label] ?? 0;
}

/** Real runner: shell to matsu's cross-battle driver per shard. Best-effort; needs the engine. */
function pythonRunner(siblingsRoot: string, deckMode: string): ShardRunner {
  return async (shard: ShardSpec) => {
    const matsu = path.join(siblingsRoot, 'ptcg-agent-matsu');
    const py = fs.existsSync(path.join(matsu, 'venv', 'bin', 'python'))
      ? path.join(matsu, 'venv', 'bin', 'python')
      : 'python3';
    const out = execFileSync(
      py,
      [
        path.join(matsu, 'eval', 'battle_matsu_take_ume.py'),
        '--n',
        String(shard.matches),
        '--seed',
        String(shard.seed),
        '--deck-mode',
        deckMode,
        '--json',
        '-',
      ],
      { cwd: matsu, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    // The driver reports pairing win rates; we translate into per-match records for the single pairing
    // that matches this shard's seat order. (Adapter kept intentionally small; the driver is the source
    // of truth for match play.)
    const parsed = JSON.parse(out) as {
      pairings?: Array<{ a: string; b: string; a_wins: number; b_wins: number; faults?: number }>;
    };
    const games: GameRecord[] = [];
    const pairing = (parsed.pairings ?? []).find(
      (p) =>
        (p.a === shard.seat0 && p.b === shard.seat1) ||
        (p.a === shard.seat1 && p.b === shard.seat0)
    );
    if (pairing) {
      const seat0Wins = pairing.a === shard.seat0 ? pairing.a_wins : pairing.b_wins;
      for (let i = 0; i < shard.matches; i++) {
        const winner = i < seat0Wins ? shard.seat0 : shard.seat1;
        games.push({
          shardId: shard.shardId,
          matchIndex: i,
          seat0: shard.seat0,
          seat1: shard.seat1,
          winner,
          fault: false,
        });
      }
    }
    return { games };
  };
}

function isoNow(): string {
  return new Date().toISOString();
}

async function cmdRun(args: Args): Promise<number> {
  const siblingsRoot = args['siblings-root'] ?? path.dirname(CONTROL_PLANE_ROOT);
  const dir = args.dir ?? path.join(CONTROL_PLANE_ROOT, 'artifacts', 'ptcg-battle-lab', 'runs');
  const storeRoot = args.store ?? path.join(CONTROL_PLANE_ROOT, 'artifacts', 'ptcg-battle-lab', 'objects');
  const runId = args['run-id'];
  if (!runId) {
    console.error('error: --run-id is required');
    return 2;
  }
  const config: RunConfig = {
    matchesPerShard: Number(args.matches ?? 40),
    seed: Number(args.seed ?? 20260718),
    deckMode: args['deck-mode'] ?? 'own',
    chunksPerOrientation: Number(args.chunks ?? 1),
  };
  const inputs = resolveInputs(siblingsRoot);
  const store = new LocalObjectStore(storeRoot);
  const runnerKind = args.runner ?? 'fixture';
  const runner: ShardRunner =
    runnerKind === 'python' ? pythonRunner(siblingsRoot, config.deckMode) : fixtureRunner;

  console.log(`ptcg-battle-lab run ${runId} (runner=${runnerKind}, matches/shard=${config.matchesPerShard})`);
  const manifest = await runRoundRobin({
    dir,
    runId,
    inputs,
    config,
    store,
    runner,
    now: isoNow,
    onShard: (id, action) => console.log(`  ${action === 'skip' ? 'skip (done)' : 'run '} ${id}`),
  });
  printStandings(manifest.aggregate);
  console.log(`manifest: ${path.relative(CONTROL_PLANE_ROOT, path.join(dir, `manifest.${runId}.json`))}`);
  return 0;
}

function cmdStatus(args: Args): number {
  const dir = args.dir ?? path.join(CONTROL_PLANE_ROOT, 'artifacts', 'ptcg-battle-lab', 'runs');
  const runId = args['run-id'];
  if (!runId) {
    console.error('error: --run-id is required');
    return 2;
  }
  const manifest = loadManifest(dir, runId);
  if (!manifest) {
    console.error(`no manifest for run ${runId}`);
    return 1;
  }
  const done = manifest.shards.filter((s) => s.status === 'completed').length;
  console.log(`run ${runId}: ${done}/${manifest.shards.length} shards completed`);
  for (const s of manifest.shards) {
    console.log(`  [${s.status === 'completed' ? 'x' : ' '}] ${s.shardId}`);
  }
  printStandings(manifest.aggregate);
  return 0;
}

function cmdPreflight(args: Args): number {
  const siblingsRoot = args['siblings-root'] ?? path.dirname(CONTROL_PLANE_ROOT);
  const inputs = resolveInputs(siblingsRoot);
  console.log('preflight — contestant inputs:');
  let ok = true;
  for (const inp of inputs) {
    const present = inp.commit !== 'unknown';
    if (!present) ok = false;
    console.log(
      `  ${inp.kanji} ${inp.label}: commit=${inp.commit.slice(0, 12)} deckHash=${inp.deckHash.slice(0, 12)}${present ? '' : '  [MISSING repo]'}`
    );
  }
  return ok ? 0 : 1;
}

function printStandings(aggregate: ReturnType<typeof loadManifest> extends null ? never : unknown): void {
  const agg = aggregate as { standings?: Array<Record<string, number | string>>; totalFaults?: number } | null;
  if (!agg || !agg.standings || agg.standings.length === 0) return;
  console.log('standings:');
  for (const row of agg.standings) {
    console.log(
      `  ${row.kanji} ${row.label}: winRate=${Number(row.winRate).toFixed(3)} [${Number(row.ciLow).toFixed(3)}, ${Number(row.ciHigh).toFixed(3)}] (n=${row.matches}, faults=${row.faults})`
    );
  }
  console.log(`  total faults: ${agg.totalFaults ?? 0}`);
}

function usage(): void {
  console.log(
    [
      'ptcg-battle-lab — resumable 松竹梅 round-robin artifact pipeline (SOT-1713)',
      '',
      'commands:',
      '  run       --run-id <id> [--matches N] [--seed N] [--deck-mode own|mirror]',
      '            [--chunks N] [--runner fixture|python] [--dir D] [--store D] [--siblings-root D]',
      '  status    --run-id <id> [--dir D]',
      '  preflight [--siblings-root D]',
      '',
      're-invoke `run` with the same --run-id to resume; completed shards are skipped.',
    ].join('\n')
  );
}

async function main(): Promise<void> {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  let code = 0;
  switch (cmd) {
    case 'run':
      code = await cmdRun(args);
      break;
    case 'status':
      code = cmdStatus(args);
      break;
    case 'preflight':
      code = cmdPreflight(args);
      break;
    default:
      usage();
      code = cmd === 'help' ? 0 : 2;
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
