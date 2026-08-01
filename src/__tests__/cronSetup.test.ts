import fs from 'node:fs';
import path from 'node:path';

describe('cron setup', () => {
  const script = fs.readFileSync(path.join(process.cwd(), 'scripts/ai/setup_cron.sh'), 'utf8');

  test('removes the obsolete untargeted run_auto cron without registering it again', () => {
    expect(script).toContain('grep -v "run_auto.sh"');
    expect(script).not.toMatch(/CRON_CMD=.*run_auto\.sh/);
    expect(script).not.toMatch(/echo \"\$CRON_CMD\"/);
  });

  test('keeps the scheduled Kaggle improvement cycle', () => {
    expect(script).toContain('kaggle_improvement_cycle.sh');
    expect(script).toContain('--only-scheduled');
  });
});
