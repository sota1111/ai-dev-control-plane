/**
 * SOT-1572 harness-lint CLI.
 *
 * Thin wrapper over src/lib/harnessLint.ts: reads the real README.md / CLAUDE.md / config/*.json /
 * .env.example / scripts/ai/*.sh from the repo root (process.cwd()), runs the drift checks, prints
 * the findings, and exits non-zero when any `fail`-level drift is present so CI can gate on it.
 * `warn`-level findings are printed but never affect the exit code.
 *
 * Run via `npm run lint:harness`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { lintHarness, hasFailures, type Finding, type HarnessLintInputs } from '../../src/lib/harnessLint.js';

const root = process.cwd();

function readText(relPath: string): string {
  return readFileSync(join(root, relPath), 'utf8');
}

function readDirTexts(relDir: string, ext: string): Array<{ name: string; text: string }> {
  let names: string[];
  try {
    names = readdirSync(join(root, relDir)).filter((n) => n.endsWith(ext));
  } catch {
    return [];
  }
  return names.map((name) => ({ name, text: readFileSync(join(root, relDir, name), 'utf8') }));
}

function buildInputs(): HarnessLintInputs {
  const workerRoles = JSON.parse(readText('config/worker_roles.json')) as Record<string, unknown>;
  return {
    workerRoles,
    configTexts: readDirTexts('config', '.json'),
    envExample: readText('.env.example'),
    claudeMd: readText('CLAUDE.md'),
    readme: readText('README.md'),
    shellScripts: readDirTexts('scripts/ai', '.sh'),
  };
}

function main(): number {
  let findings: Finding[];
  try {
    findings = lintHarness(buildInputs());
  } catch (err) {
    console.error(`harness-lint: could not read inputs: ${(err as Error).message}`);
    return 2;
  }

  const fails = findings.filter((f) => f.severity === 'fail');
  const warns = findings.filter((f) => f.severity === 'warn');

  for (const f of fails) console.error(`[FAIL] ${f.check}: ${f.message}`);
  for (const f of warns) console.warn(`[warn] ${f.check}: ${f.message}`);

  console.log(`\nharness-lint: ${fails.length} drift failure(s), ${warns.length} warning(s).`);
  if (hasFailures(findings)) {
    console.error('harness-lint: drift detected — see [FAIL] lines above.');
    return 1;
  }
  console.log('harness-lint: no drift failures.');
  return 0;
}

process.exit(main());
