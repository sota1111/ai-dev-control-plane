import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve('scripts/ai/robust_acceptance.py');

interface RunResult {
  status: number;
  json: {
    n_entities: number;
    direction: string;
    delta_total: number;
    improved: boolean;
    k_star: number;
    public_size: number | null;
    judgement: string;
    removal_curve: Array<{ entity: string; still_improved: boolean }>;
  };
  stderr: string;
}

function writeCsv(dir: string, name: string, rows: Array<[string, number]>): string {
  const body = ['entity,loss', ...rows.map(([e, l]) => `${e},${l}`)].join('\n') + '\n';
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

function run(args: string[]): RunResult {
  const proc = spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8' });
  if (proc.error) throw proc.error;
  let json: RunResult['json'] = undefined as unknown as RunResult['json'];
  const out = (proc.stdout || '').trim();
  if (out) json = JSON.parse(out);
  return { status: proc.status ?? -1, json, stderr: proc.stderr || '' };
}

describe('SOT-2515 robust_acceptance.py (leave-largest-contribution-out)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sot-2515-'));
  const base5 = writeCsv(dir, 'base5.csv', [
    ['a', 10],
    ['b', 10],
    ['c', 10],
    ['d', 10],
    ['e', 10],
  ]);

  it('few-dominated improvement is rejected (k* small)', () => {
    const treat = writeCsv(dir, 'treat_few.csv', [
      ['a', 0],
      ['b', 10],
      ['c', 10],
      ['d', 10],
      ['e', 10],
    ]);
    const { status, json } = run(['--base', base5, '--treat', treat, '--public-size', '3']);
    expect(json.improved).toBe(true);
    expect(json.k_star).toBe(1);
    expect(json.judgement).toBe('reject');
    expect(status).toBe(1);
  });

  it('broadly-distributed improvement is accepted (k* large)', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const base = writeCsv(
      dir,
      'base10.csv',
      rows.map((r) => [r, 10] as [string, number])
    );
    const treat = writeCsv(
      dir,
      'treat_broad.csv',
      rows.map((r) => [r, 9] as [string, number])
    );
    const { status, json } = run(['--base', base, '--treat', treat, '--public-size', '3']);
    expect(json.k_star).toBe(10);
    expect(json.judgement).toBe('accept');
    expect(status).toBe(0);
  });

  it('identical inputs yield k*=0 and reject', () => {
    const { status, json } = run(['--base', base5, '--treat', base5, '--public-size', '0']);
    expect(json.improved).toBe(false);
    expect(json.k_star).toBe(0);
    expect(json.judgement).toBe('reject');
    expect(status).toBe(1);
  });

  it('report-only mode (no --public-size) exits 0 and does not judge', () => {
    const treat = writeCsv(dir, 'treat_few2.csv', [
      ['a', 0],
      ['b', 10],
      ['c', 10],
      ['d', 10],
      ['e', 10],
    ]);
    const { status, json } = run(['--base', base5, '--treat', treat]);
    expect(status).toBe(0);
    expect(json.public_size).toBeNull();
    expect(json.judgement).toBe('report_only');
    expect(json.k_star).toBe(1);
  });

  it('higher-better metric flips the improvement direction', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'];
    const base = writeCsv(
      dir,
      'base_hi.csv',
      rows.map((r) => [r, 0.5] as [string, number])
    );
    const treat = writeCsv(
      dir,
      'treat_hi.csv',
      rows.map((r) => [r, 0.6] as [string, number])
    );
    const { json } = run([
      '--base',
      base,
      '--treat',
      treat,
      '--higher-better',
      '--public-size',
      '2',
    ]);
    expect(json.direction).toBe('higher_better');
    expect(json.improved).toBe(true);
    expect(json.k_star).toBe(5);
    expect(json.judgement).toBe('accept');
  });

  it('errors on mismatched entity sets (exit 2)', () => {
    const bad = writeCsv(dir, 'bad_entities.csv', [
      ['a', 1],
      ['b', 2],
    ]);
    const { status, stderr } = run(['--base', base5, '--treat', bad]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/entity sets differ/);
  });

  it('errors on non-numeric loss (exit 2)', () => {
    const bad = join(dir, 'nonnumeric.csv');
    writeFileSync(bad, 'entity,loss\na,foo\nb,10\nc,10\nd,10\ne,10\n');
    const { status, stderr } = run(['--base', base5, '--treat', bad]);
    expect(status).toBe(2);
    expect(stderr).toMatch(/non-numeric/);
  });
});
