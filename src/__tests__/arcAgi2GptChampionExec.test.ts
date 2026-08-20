import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtime = path.resolve('kaggle/arc-agi-2-gpt-champion/submission.py');
const registry = JSON.parse(
  fs.readFileSync(path.resolve('scripts/ai/kaggle_targets_registry.json'), 'utf8')
);
const target = registry.competitions
  .find((competition: { key: string }) => competition.key === 'arc-agi-2')
  ?.targets.find((entry: { lineage: string }) => entry.lineage === 'gpt');

// arc-agi-2 は kaggle 改善サイクルの完了駆動ループ化に伴い registry から削除済み（biohub+kaggriculture
// のみ運用）。提出/champion 設定が registry に無くなったため、このコンペ固有の契約テストは撤去（skip）。
const describeArcAgi2 = target ? describe : describe.skip;
describeArcAgi2('ARC-AGI-2 GPT champion kernel', () => {
  it('pins the exec artifact to the incumbent identity champion fingerprint', () => {
    const fingerprint = createHash('sha256').update(fs.readFileSync(runtime)).digest('hex');
    expect(target).toMatchObject({
      champion_status: 'exec-verified',
      submit: {
        kernel: 'sota1111/arc-agi-2-gpt-identity-champion',
        candidate_id: 'identity',
        artifact_fingerprint: `sha256:${fingerprint}`,
      },
    });
  });

  it('executes offline from an unrelated cwd and writes the required attempt schema', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-agi-2-gpt-'));
    const challengePath = path.join(temp, 'challenges.json');
    const outputPath = path.join(temp, 'nested', 'submission.json');
    const challenges = {
      task_a: {
        train: [],
        test: [
          {
            input: [
              [1, 0],
              [0, 2],
            ],
          },
          { input: [[3]] },
        ],
      },
    };
    fs.writeFileSync(challengePath, JSON.stringify(challenges));

    const result = spawnSync('python3', [runtime], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        ARC_CHALLENGES_PATH: challengePath,
        ARC_SUBMISSION_PATH: outputPath,
        PYTHONNOUSERSITE: '1',
      },
    });

    expect(result).toMatchObject({ status: 0, stderr: '' });
    const submission = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(submission).toEqual({
      task_a: [
        {
          attempt_1: [
            [1, 0],
            [0, 2],
          ],
          attempt_2: [
            [1, 0],
            [0, 2],
          ],
        },
        { attempt_1: [[3]], attempt_2: [[3]] },
      ],
    });
    for (const attempts of Object.values(submission) as Array<Array<Record<string, unknown>>>) {
      for (const attempt of attempts) {
        expect(Object.keys(attempt).sort()).toEqual(['attempt_1', 'attempt_2']);
      }
    }
  });

  it('fails closed on invalid grids', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-agi-2-invalid-'));
    const challengePath = path.join(temp, 'challenges.json');
    fs.writeFileSync(
      challengePath,
      JSON.stringify({ invalid: { test: [{ input: [[1], [2, 3]] }] } })
    );
    const result = spawnSync('python3', [runtime], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        ARC_CHALLENGES_PATH: challengePath,
        ARC_SUBMISSION_PATH: path.join(temp, 'submission.json'),
        PYTHONNOUSERSITE: '1',
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must be rectangular');
  });
});
