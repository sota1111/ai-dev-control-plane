import fs from 'node:fs';
import path from 'node:path';

describe('kaggle improvement cron ownership', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'scripts', 'ai', 'kaggle_improvement_cycle.sh'),
    'utf8'
  );

  test('draft cron never invokes the submission helper', () => {
    expect(source).not.toMatch(/bash\s+"\$SCRIPT_DIR\/kaggle_targets_submit\.sh"/);
    expect(source).toContain('再開された親Issueが実行');
  });
});
