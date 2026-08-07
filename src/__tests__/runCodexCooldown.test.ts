import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runCodex = path.join(repoRoot, 'scripts/ai/run_codex.sh');

describe('run_codex usage-limit cooldown', () => {
  test('does not create a cooldown from usage-limit words in a successful report', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-codex-cooldown-'));
    const scriptDir = path.join(dir, 'scripts/ai');
    const promptDir = path.join(dir, 'prompts/codex');
    const binDir = path.join(dir, 'bin');
    const localBinDir = path.join(dir, 'node_modules/.bin');
    const cooldownFile = path.join(dir, 'docs/ai/auto_logs/codex.cooldown.json');

    fs.mkdirSync(scriptDir, { recursive: true });
    fs.mkdirSync(promptDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(localBinDir, { recursive: true });
    fs.copyFileSync(runCodex, path.join(scriptDir, 'run_codex.sh'));
    fs.writeFileSync(path.join(promptDir, 'debug.md'), 'test prompt');
    fs.writeFileSync(
      path.join(binDir, 'codex'),
      `#!/usr/bin/env bash
echo "Investigated usage limit handling."
echo "The phrase try again at is data, not a CLI failure."
echo "## Next Action"
echo "Done"
exit 0
`,
      { mode: 0o755 }
    );
    // Best-effort notifier calls do not need the real TypeScript CLI in this isolated harness.
    fs.writeFileSync(path.join(localBinDir, 'tsx'), '#!/usr/bin/env bash\nexit 0\n', {
      mode: 0o755,
    });

    try {
      execFileSync('bash', [path.join(scriptDir, 'run_codex.sh')], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH || ''}`,
          CODEX_HARNESS_SPEC: '0',
          WORKER_SESSION_REUSE: '0',
        },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      expect(fs.existsSync(cooldownFile)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
