// SOT-1549: CLI wrapper that the dispatcher (scripts/ai/run_worker.sh) calls to emit a leg's metrics
// JSON. The shell measures the raw values (start/end epoch-ms, `git diff --numstat`, exit codes) and
// this thin CLI shapes them into the stable schema via src/lib/legMetrics.ts — the single source of
// truth for the metrics shape. Invoked as:
//
//   tsx src/lib/legMetricsCli.ts \
//     --issue SOT-1549 --role implementation --worker codex --sequence 0 --exit 0 \
//     --start-ms 1730000000000 --end-ms 1730000060000 \
//     [--numstat-file /tmp/numstat] [--lint-exit 0 --typecheck-exit 0 --test-exit 1 --e2e-exit 0] \
//     [--handoff-from claude] [--report docs/ai/60_worker_codex_report.md] [--repo /workspaces/foo] \
//     [--out-dir docs/ai/auto_logs/metrics] [--filename leg-...json]
//
// With --out-dir it writes the JSON to <out-dir>/<filename> and prints the written path; otherwise it
// prints the JSON to stdout. It is deliberately forgiving: any shaping error still exits 0 so metrics
// collection never breaks dispatch.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildLegMetrics,
  legMetricsFilename,
  type GateExitCodes,
  type LegMetricsInput,
} from './legMetrics.js';

interface Args {
  [key: string]: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = 'true';
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function num(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optNum(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readNumstat(args: Args): string | undefined {
  if (args['numstat-file']) {
    try {
      return fs.readFileSync(args['numstat-file'], 'utf8');
    } catch {
      return undefined;
    }
  }
  return args.numstat;
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (!args.role || !args.worker) {
    process.stderr.write('legMetricsCli: --role and --worker are required\n');
    return 0; // fail-open: never break dispatch
  }

  const gate: GateExitCodes = {
    lint: optNum(args['lint-exit']),
    typecheck: optNum(args['typecheck-exit']),
    test: optNum(args['test-exit']),
    e2e: optNum(args['e2e-exit']),
  };

  const input: LegMetricsInput = {
    issue: args.issue ?? null,
    role: args.role,
    worker: args.worker,
    sequence: num(args.sequence),
    exitCode: num(args.exit),
    startMs: num(args['start-ms']),
    endMs: num(args['end-ms']),
    numstat: readNumstat(args),
    gate,
    handoffFrom: args['handoff-from'] ?? null,
    reportPath: args.report ?? null,
    repo: args.repo ?? null,
  };

  const metrics = buildLegMetrics(input);
  const json = JSON.stringify(metrics, null, 2);

  const outDir = args['out-dir'];
  if (outDir) {
    try {
      fs.mkdirSync(outDir, { recursive: true });
      const filename = args.filename || legMetricsFilename(metrics);
      const outPath = path.join(outDir, filename);
      fs.writeFileSync(outPath, `${json}\n`);
      process.stdout.write(`${outPath}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`legMetricsCli: write failed: ${String(err)}\n`);
      return 0;
    }
  }

  process.stdout.write(`${json}\n`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
