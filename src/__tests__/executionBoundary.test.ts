import fs from 'node:fs';
import path from 'node:path';

describe('execution-only repository boundary', () => {
  test('control-plane Linear API has no issueCreate mutation', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/linearApi.ts'), 'utf8');
    expect(source).not.toContain('issueCreate(');
    expect(source).not.toContain('createDraftIssue');
  });

  test('historical automatic drafting entrypoints are absent', () => {
    for (const name of [
      'kaggle_improvement_cycle.sh',
      'sonnet_gold_cycle.sh',
      'sonnet_gold_cycle_draft.ts',
      'nedo_loading_cycle.sh',
      'nedo_loading_cycle_draft.ts',
    ]) {
      expect(fs.existsSync(path.join(process.cwd(), 'scripts/ai', name))).toBe(false);
    }
  });

  test('legacy Kaggle planner cannot execute issue creation', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/runner-cli.ts'), 'utf8');
    expect(source).toContain('issue creation moved to epistemic-research-loop');
    expect(source).toContain('executed: false');
    expect(source).not.toContain('kaggle-improve-plan');
    expect(source).not.toContain('createDraftIssue');
  });
});
