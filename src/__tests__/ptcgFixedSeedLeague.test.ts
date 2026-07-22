import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

describe('SOT-1847 fixed-seed league', () => {
  it('publishes a complete reproducible seven-agent matrix and resumes cleanly', () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'sot-1847-'));
    const run = () =>
      spawnSync(process.execPath, ['--import', 'tsx', 'src/ptcg-fixed-seed-league-cli.ts', output], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
    const first = run();
    expect(first.status).toBe(0);
    const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'));
    expect(report).toMatchObject({
      planned: 840,
      recorded: 840,
      duplicateMatchIds: [],
      missingMatchIds: [],
      unknownMatchIds: [],
      totals: { faults: 0, unfinished: 0 },
    });
    expect(report.matchups).toHaveLength(21);
    expect(report.matchups.every((row: { decided: number }) => row.decided === 40)).toBe(true);
    const checkpointBefore = fs.readFileSync(path.join(output, 'checkpoint.json'), 'utf8');
    const second = run();
    expect(second.status).toBe(0);
    expect(fs.readFileSync(path.join(output, 'checkpoint.json'), 'utf8')).toBe(checkpointBefore);
    expect(fs.readFileSync(path.join(output, 'audit.md'), 'utf8')).toContain(
      'Fault / unfinished / timeout: 0 / 0 / 0'
    );
  });
});
