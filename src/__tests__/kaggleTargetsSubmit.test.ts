import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const script = path.join(repoRoot, 'scripts', 'ai', 'kaggle_targets_submit.sh');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaggle-slots-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const artifact = path.join(dir, 'submission.csv');
  fs.writeFileSync(artifact, 'id,prediction\n1,ok\n');
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(
    registry,
    JSON.stringify({
      enabled: true,
      schedule_hours_jst: [0, 12],
      rotation: [
        { hour_jst: 0, competition: 'demo' },
        { hour_jst: 12, competition: 'demo' },
      ],
      issue_cap_guard: 240,
      competitions: [
        {
          key: 'demo',
          kaggle_competition: 'demo-comp',
          daily_submission_cap: 5,
          daily_submissions_per_lineage: 2,
          submission_mode: 'both',
          targets: [
            {
              lineage: 'claude',
              repo: 'demo-claude',
              project: 'demo-claude',
              workers_directive: 'solo=claude',
              submit: { file: artifact, message: 'demo-claude' },
              next_cycle: 1,
            },
            {
              lineage: 'gpt',
              repo: 'demo-gpt',
              project: 'demo-gpt',
              workers_directive: 'solo=codex',
              submit: { file: artifact, message: 'demo-gpt' },
              next_cycle: 1,
            },
          ],
        },
      ],
    })
  );
  return { dir, bin, registry };
}

describe('kaggle_targets_submit safety gates', () => {
  test('authentication/history failure safely skips every submission', () => {
    const { dir, bin, registry } = fixture();
    const calls = path.join(dir, 'calls');
    fs.writeFileSync(
      path.join(bin, 'kaggle'),
      `#!/usr/bin/env bash
echo "$*" >> "${calls}"
echo "401 Unauthorized" >&2
exit 1
`
    );
    fs.chmodSync(path.join(bin, 'kaggle'), 0o755);

    const output = execFileSync(
      'bash',
      [script, '--registry', registry, '--competition', 'demo', '--hour', '0', '--execute'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          KAGGLE_SUBMISSION_HISTORY: path.join(dir, 'history.jsonl'),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    expect(output).toContain('measurement unavailable');
    expect(fs.readFileSync(calls, 'utf8')).not.toContain('competitions submit');
  });

  test('a completed slot marker makes an execute rerun idempotent', () => {
    const { dir, bin, registry } = fixture();
    const calls = path.join(dir, 'calls');
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(bin, 'kaggle'),
      `#!/usr/bin/env bash
echo "$*" >> "${calls}"
if [[ "$*" == *"competitions submissions"* ]]; then
  cat <<'EOF'
ref  fileName  date  description  status  publicScore
---  --------  ----  -----------  ------  -----------
101  submission.csv  ${today}  demo-claude [slot:${today}-jst-00]  COMPLETE  0.51
102  submission.csv  ${today}  demo-gpt [slot:${today}-jst-00]  COMPLETE  0.49
EOF
  exit 0
fi
exit 0
`
    );
    fs.chmodSync(path.join(bin, 'kaggle'), 0o755);

    const output = execFileSync(
      'bash',
      [script, '--registry', registry, '--competition', 'demo', '--hour', '0', '--execute'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          KAGGLE_SUBMISSION_HISTORY: path.join(dir, 'history.jsonl'),
        },
        encoding: 'utf8',
      }
    );
    expect(output).toContain('daily slot already completed');
    expect(fs.readFileSync(calls, 'utf8')).not.toContain('competitions submit -c');
  });
});
