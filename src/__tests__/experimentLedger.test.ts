import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultExperimentLedgerPath,
  readExperimentLedger,
  summarizeExperimentLedger,
  type ExperimentLedgerEntry,
} from '../lib/experimentLedger.js';

describe('experimentLedger — readExperimentLedger', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-ledger-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] for a missing file', () => {
    expect(readExperimentLedger(path.join(dir, 'none.jsonl'))).toEqual([]);
  });

  it('reads valid JSONL entries and skips broken/invalid lines', () => {
    const file = path.join(dir, 'ledger.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ recordedAt: '2026-08-01T00:00:00Z', axis: 'belief-width', result: 'rejected' }),
      '{ broken json',
      JSON.stringify({ recordedAt: '2026-08-02T00:00:00Z', result: 'promoted' }), // no axis
      JSON.stringify({ recordedAt: '2026-08-02T00:00:00Z', axis: 'dog-detection', result: 'promoted', evidence: 'micro 0.506→0.772' }),
      JSON.stringify({ recordedAt: '2026-08-02T00:00:00Z', axis: 'x', result: 'weird' }), // invalid result
    ].join('\n'));
    const entries = readExperimentLedger(file);
    expect(entries.map((e) => e.axis)).toEqual(['belief-width', 'dog-detection']);
  });

  it('resolves the conventional path inside a target repo', () => {
    expect(defaultExperimentLedgerPath('/workspaces/sample-app'))
      .toBe('/workspaces/sample-app/docs/ai/experiment_ledger.jsonl');
  });
});

describe('experimentLedger — summarizeExperimentLedger', () => {
  it('reports the empty-ledger bootstrap message', () => {
    expect(summarizeExperimentLedger([])).toContain('実験台帳なし');
  });

  it('groups by axis with latest-result-wins and lists rejected axes as a no-retry contract', () => {
    const entries: ExperimentLedgerEntry[] = [
      { recordedAt: '2026-07-01T00:00:00Z', axis: 'value-net', result: 'rejected' },
      { recordedAt: '2026-07-10T00:00:00Z', axis: 'value-net', result: 'promoted', evidence: 'warm-start 0.10→0.55' },
      { recordedAt: '2026-07-05T00:00:00Z', axis: 'belief-width', result: 'rejected', evidence: 'n_worlds 4→6 non-promoted' },
      { recordedAt: '2026-07-06T00:00:00Z', axis: 'meta-deck', result: 'inconclusive' },
    ];
    const summary = summarizeExperimentLedger(entries);
    expect(summary).toContain('試行済み軸: 3');
    expect(summary).toContain('昇格 1 / 非昇格 1 / 不確定 1');
    // latest result wins: value-net counts as promoted, not rejected
    expect(summary).toMatch(/昇格済み:\n- value-net — warm-start 0.10→0.55/);
    expect(summary).toMatch(/非昇格（新しい根拠なしの再試行は禁止）:\n- belief-width — n_worlds 4→6 non-promoted/);
  });
});
