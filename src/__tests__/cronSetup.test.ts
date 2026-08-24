import fs from 'node:fs';
import path from 'node:path';

describe('cron setup', () => {
  const script = fs.readFileSync(path.join(process.cwd(), 'scripts/ai/setup_cron.sh'), 'utf8');

  test('removes all historical automatic drafting cron entries', () => {
    expect(script).toContain('LEGACY_PATTERN');
    expect(script).toContain('sonnet_gold_cycle');
    expect(script).toContain('nedo_loading_cycle');
  });

  test('does not register replacement work and points operators to webhook ingress', () => {
    expect(script).not.toMatch(/echo\s+"\$.*CMD"\s*\|\s*crontab/);
    expect(script).toContain('npm run start:webhook');
    expect(script).toContain('epistemic-research-loop');
  });
});
