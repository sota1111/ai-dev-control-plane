import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dispatcher = path.join(repoRoot, 'scripts/ai/run_worker.sh');

function soloDryRun(handoff: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-dispatch-'));
  const configPath = path.join(dir, 'worker_roles.json');
  fs.writeFileSync(configPath, JSON.stringify({
    __solo__: 'claude',
    __handoff__: handoff,
    'task-check': ['claude', 'codex', 'antigravity'],
  }));
  try {
    return execFileSync('bash', [dispatcher, 'solo', '--dry-run'], {
      cwd: repoRoot,
      env: { ...process.env, WORKER_ROLES_FILE: configPath },
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('run_worker solo handoff policy', () => {
  test('handoff enabled falls back through the configured worker chain', () => {
    const output = soloDryRun(true);
    expect(output).toContain('chain=[claude codex antigravity]');
    expect(output).toContain('run_claude.sh');
    expect(output).toContain('run_codex.sh');
    expect(output).toContain('run_antigravity.sh');
  });

  test('handoff disabled keeps solo on the selected worker', () => {
    const output = soloDryRun(false);
    expect(output).toContain('chain=[claude]');
    expect(output).toContain('run_claude.sh');
    expect(output).not.toContain('run_codex.sh');
    expect(output).not.toContain('run_antigravity.sh');
  });
});
