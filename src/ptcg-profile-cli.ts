import { loadPtcgProfileConfig, preflightPtcg } from './lib/ptcgProfile.js';

const args = process.argv.slice(2);
if (args[0] !== 'preflight') {
  process.stderr.write('Usage: tsx src/ptcg-profile-cli.ts preflight [--config PATH]\n');
  process.exit(2);
}
const configIndex = args.indexOf('--config');
const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
try {
  const result = preflightPtcg(loadPtcgProfileConfig(configPath));
  for (const check of result.checks)
    process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}\n`);
  process.exit(result.ok ? 0 : 1);
} catch (error: any) {
  process.stderr.write(`PTCG preflight config error: ${error.message}\n`);
  process.exit(1);
}
