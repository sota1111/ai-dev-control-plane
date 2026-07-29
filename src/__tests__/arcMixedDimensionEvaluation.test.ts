import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('SOT-2180 mixed-dimension evaluation', () => {
  it('keeps cohort order fixed and rejects ambiguous candidates safely', () => {
    const dataset = process.env.ARC_AGI_2_EVALUATION;
    if (!dataset) return;
    const output = join(mkdtempSync(join(tmpdir(), 'sot-2180-')), 'evidence.json');
    execFileSync(
      'python3',
      [
        resolve('scripts/ai/evaluate_arc_mixed_dimension.py'),
        '--dataset',
        dataset,
        '--spec',
        resolve('docs/ai/kaggle/SOT-2179-mixed-dimension-structural-spec.json'),
        '--output',
        output,
      ],
      { stdio: 'pipe' }
    );
    const evidence = JSON.parse(readFileSync(output, 'utf8'));
    expect(evidence.protocol).toBe('screen-then-independent-confirm');
    expect(evidence.decision).toBe('reject');
    expect(evidence.accepted_candidates).toEqual([]);
    expect(evidence.behavior_changes_reverted).toBe(true);
    expect(evidence.registry_champion_after).toBe('identity');
    expect(
      evidence.candidates.every(
        (candidate: { screen: { faults: number }; confirm: { status: string } }) =>
          candidate.screen.faults === 0 && candidate.confirm.status === 'not_run'
      )
    ).toBe(true);
  });
});
