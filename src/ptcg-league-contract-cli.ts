import fs from 'node:fs';
import {
  parseMatchJsonl,
  validateRegistry,
  type LeagueRegistry,
} from './lib/ptcgLeagueContract.js';

const [command, file, registryFile] = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (command === 'validate-registry' && file) {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const errors = validateRegistry(value);
  if (errors.length) fail(errors.join('\n'));
  console.log(`valid registry: ${file}`);
} else if (command === 'validate-jsonl' && file) {
  let registry: LeagueRegistry | undefined;
  if (registryFile) {
    const value: unknown = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    const errors = validateRegistry(value);
    if (errors.length) fail(`invalid registry: ${errors.join('; ')}`);
    registry = value as LeagueRegistry;
  }
  const records = parseMatchJsonl(fs.readFileSync(file, 'utf8'), registry);
  console.log(`valid JSONL: ${records.length} record(s)`);
} else {
  fail(
    'usage: ptcg-league-contract-cli validate-registry <registry.json> | validate-jsonl <matches.jsonl> [registry.json]'
  );
}
