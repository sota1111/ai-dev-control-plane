import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

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
          KAGGLE_HISTORY_ATTEMPTS: '2',
          KAGGLE_HISTORY_RETRY_DELAY_SECONDS: '0',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    expect(output).toContain('measurement unavailable');
    expect(fs.readFileSync(calls, 'utf8').match(/competitions submissions/g)).toHaveLength(2);
    expect(fs.readFileSync(calls, 'utf8')).not.toContain('competitions submit');
  });

  test('recognizes a submitted artifact fingerprint and blocks an identical second slot', () => {
    const { dir, bin, registry } = fixture();
    const calls = path.join(dir, 'calls');
    const today = new Date().toISOString().slice(0, 10);
    const artifact = JSON.parse(fs.readFileSync(registry, 'utf8')).competitions[0].targets[0].submit.file;
    const fingerprint = createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
    fs.writeFileSync(
      path.join(bin, 'kaggle'),
      `#!/usr/bin/env bash
echo "$*" >> "${calls}"
if [[ "$*" == *"competitions submissions"* ]]; then
  cat <<'EOF'
ref  fileName  date  description  status  publicScore
---  --------  ----  -----------  ------  -----------
101  submission.csv  ${today}  demo-claude [repo:demo-claude] [artifact:sha256:${fingerprint}]  COMPLETE  0.51
EOF
fi
`
    );
    fs.chmodSync(path.join(bin, 'kaggle'), 0o755);

    const output = execFileSync(
      'bash',
      [script, '--registry', registry, '--competition', 'demo', '--repo', 'demo-claude', '--hour', '12', '--execute'],
      {
        cwd: repoRoot,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KAGGLE_SUBMISSION_HISTORY: path.join(dir, 'history.jsonl') },
        encoding: 'utf8',
      }
    );
    expect(output).toContain('selected artifact was already submitted today');
    expect(fs.readFileSync(calls, 'utf8')).not.toContain('competitions submit -c');
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

  test('builds a missing artifact via scripts/build_submission.sh before submitting', () => {
    // Regression (PTCG Claude): submission.tar.gz is a gitignored build artifact. When a diagnostic-only
    // run leaves the checkout without it, the submit must build it from the champion checkout rather than
    // skip — otherwise the champion never reaches Kaggle.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaggle-build-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // Repo checkout with a build script but NO artifact yet.
    const repo = path.join(dir, 'demo-claude');
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    const artifact = path.join(repo, 'submission.tar.gz');
    fs.writeFileSync(
      path.join(repo, 'scripts', 'build_submission.sh'),
      `#!/usr/bin/env bash\nset -euo pipefail\nprintf 'champion-artifact' > "${artifact}"\necho "submission archive: ${artifact}"\n`
    );
    fs.chmodSync(path.join(repo, 'scripts', 'build_submission.sh'), 0o755);
    expect(fs.existsSync(artifact)).toBe(false);

    const registry = path.join(dir, 'registry.json');
    fs.writeFileSync(
      registry,
      JSON.stringify({
        enabled: true,
        schedule_hours_jst: [0],
        rotation: [{ hour_jst: 0, competition: 'demo' }],
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
            ],
          },
        ],
      })
    );

    const calls = path.join(dir, 'calls');
    // Stub kaggle: empty submissions history (no dedup block) → proceed to submit.
    fs.writeFileSync(
      path.join(bin, 'kaggle'),
      `#!/usr/bin/env bash\necho "$*" >> "${calls}"\nif [[ "$*" == *"competitions submissions"* ]]; then\n  echo "ref  fileName  date  description  status  publicScore"\nfi\nexit 0\n`
    );
    fs.chmodSync(path.join(bin, 'kaggle'), 0o755);

    const output = execFileSync(
      'bash',
      [script, '--registry', registry, '--competition', 'demo', '--repo', 'demo-claude', '--hour', '0', '--execute'],
      {
        cwd: repoRoot,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KAGGLE_SUBMISSION_HISTORY: path.join(dir, 'history.jsonl') },
        encoding: 'utf8',
      }
    );

    // The build ran, the artifact now exists, and a real submit happened for it.
    expect(output).toContain('build 完了');
    expect(fs.existsSync(artifact)).toBe(true);
    expect(fs.readFileSync(calls, 'utf8')).toContain('competitions submit -c demo-comp');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('still skips (no build) when the artifact is missing and there is no build script', () => {
    const { dir, bin, registry } = fixture();
    // Point submit.file at a missing path with no build script alongside it.
    const reg = JSON.parse(fs.readFileSync(registry, 'utf8'));
    const missing = path.join(dir, 'nope', 'submission.csv');
    reg.competitions[0].targets[0].submit.file = missing;
    reg.competitions[0].targets[1].submit.file = missing;
    fs.writeFileSync(registry, JSON.stringify(reg));
    const calls = path.join(dir, 'calls');
    fs.writeFileSync(
      path.join(bin, 'kaggle'),
      `#!/usr/bin/env bash\necho "$*" >> "${calls}"\nif [[ "$*" == *"competitions submissions"* ]]; then\n  echo "ref  fileName  date  description  status  publicScore"\nfi\nexit 0\n`
    );
    fs.chmodSync(path.join(bin, 'kaggle'), 0o755);

    const output = execFileSync(
      'bash',
      [script, '--registry', registry, '--competition', 'demo', '--hour', '0', '--execute'],
      {
        cwd: repoRoot,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KAGGLE_SUBMISSION_HISTORY: path.join(dir, 'history.jsonl') },
        encoding: 'utf8',
      }
    );
    // The "提出物が見つかりません" NOTICE is on stderr; the safety property is that NO submit happened.
    void output;
    expect(fs.readFileSync(calls, 'utf8')).not.toContain('competitions submit -c');
  });
});
