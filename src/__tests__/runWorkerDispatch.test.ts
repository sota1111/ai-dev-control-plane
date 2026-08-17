import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dispatcher = path.join(repoRoot, 'scripts/ai/run_worker.sh');

function soloDryRun(handoff: boolean, extraEnv: Record<string, string> = {}): string {
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
      env: { ...process.env, WORKER_ROLES_FILE: configPath, ...extraEnv },
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

// SOT-2725: the dispatcher itself moves the target issue to In Progress at dispatch start so manual
// run_worker.sh (solo/role) invocations — which never traverse run_auto.sh's SOT-1590 transition —
// still leave Backlog/Todo immediately. Dry-run mode surfaces the intent without hitting Linear.
describe('run_worker dispatch sets Linear In Progress', () => {
  test('dry-run surfaces the In Progress transition for the injected issue', () => {
    const output = soloDryRun(true, { WEBHOOK_ISSUE_ID: 'SOT-9999' });
    expect(output).toContain('DRY_RUN would set-issue-in-progress: SOT-9999');
  });

  test('the transition can be disabled with RUN_WORKER_SET_IN_PROGRESS=0', () => {
    const output = soloDryRun(true, {
      WEBHOOK_ISSUE_ID: 'SOT-9999',
      RUN_WORKER_SET_IN_PROGRESS: '0',
    });
    expect(output).not.toContain('set-issue-in-progress');
  });
});
