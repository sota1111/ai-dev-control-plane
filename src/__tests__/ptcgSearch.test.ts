import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  comparePtcgSearchBackends,
  createDefaultPtcgSearchRegistry,
  PTCG_SEARCH_API_VERSION,
} from '../lib/ptcgSearch.js';
import { ptcgAgentContractFixtures } from '../testing/ptcgAgentContractFixtures.js';

const fixture = ptcgAgentContractFixtures[0].createObservation();

describe('pluggable PTCG search backends', () => {
  it('selects all four backends through one contract', () => {
    const registry = createDefaultPtcgSearchRegistry();
    expect(registry.ids()).toEqual(['mcts', 'alphazero', 'rule-based', 'hybrid']);
    for (const id of registry.ids()) {
      const backend = registry.create(id);
      expect(backend.apiVersion).toBe(PTCG_SEARCH_API_VERSION);
      expect(backend.id).toBe(id);
      expect(fixture.legalActionIds).toContain(
        backend.search(fixture, { seed: 1768, simulations: 32 }).actionId
      );
    }
  });

  it('compares every backend on the identical fixture and configuration', () => {
    const results = comparePtcgSearchBackends(fixture, { seed: 1768, simulations: 32 });
    expect(results.map(({ backend }) => backend)).toEqual([
      'mcts',
      'alphazero',
      'rule-based',
      'hybrid',
    ]);
    expect(results.every(({ seed, simulations }) => seed === 1768 && simulations === 32)).toBe(
      true
    );
    expect(results.every(({ actionId }) => fixture.legalActionIds.includes(actionId))).toBe(true);
  });

  it.each(['mcts', 'alphazero', 'rule-based', 'hybrid'] as const)(
    '%s is reproducible with a deterministic seed',
    (id) => {
      const backend = createDefaultPtcgSearchRegistry().create(id);
      expect(backend.search(fixture, { seed: 42, simulations: 20 })).toEqual(
        backend.search(fixture, { seed: 42, simulations: 20 })
      );
    }
  );

  it('provides a working benchmark CLI entrypoint', () => {
    const fixtureFile = join(tmpdir(), `ptcg-search-${process.pid}.json`);
    writeFileSync(fixtureFile, JSON.stringify(fixture));
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/ptcg-search-benchmark-cli.ts', fixtureFile, 'all', '1768', '8'],
      { cwd: process.cwd(), encoding: 'utf8' }
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout) as { results: Array<{ backend: string }> };
    expect(report.results).toHaveLength(4);
  });
});
