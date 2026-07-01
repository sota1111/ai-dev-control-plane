import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// SOT-1421 / P6 — best-effort auto-redeploy hook behavior.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'ai', 'redeploy_after_merge.sh');

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('redeploy_after_merge.sh', () => {
  test('bad usage (no args) exits 2', () => {
    const r = run([]);
    expect(r.status).toBe(2);
  });

  test('disabled by default (REDEPLOY_ENABLED unset) → skip, exit 0', () => {
    const r = run(['owner/repo'], { REDEPLOY_ENABLED: '' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('disabled');
    expect(r.stdout).toContain('skipping');
  });

  test('enabled but no command configured → skip, exit 0', () => {
    // Point at an empty-ish command source: no REDEPLOY_CMD, unknown key in the map.
    const r = run(['definitely-not-a-configured-key'], { REDEPLOY_ENABLED: '1', REDEPLOY_CMD: '' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no deploy command configured');
  });

  test('enabled with REDEPLOY_CMD → runs the command, exit 0', () => {
    const r = run(['owner/repo'], { REDEPLOY_ENABLED: 'true', REDEPLOY_CMD: 'echo DEPLOYED_OK' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DEPLOYED_OK');
    expect(r.stdout).toContain('deploy complete');
  });

  test('enabled but the deploy command fails → best-effort, still exit 0', () => {
    const r = run(['owner/repo'], { REDEPLOY_ENABLED: '1', REDEPLOY_CMD: 'exit 3' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('FAILED');
  });
});
