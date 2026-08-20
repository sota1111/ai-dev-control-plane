import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const executable = path.resolve('scripts/ai/arc_agi3_champion_exec.py');
const replay = JSON.parse(
  fs.readFileSync(path.resolve('src/__fixtures__/arcAgi3GatewayReplay.json'), 'utf8')
);
const registry = JSON.parse(
  fs.readFileSync(path.resolve('artifacts/arc-agi-3/sot-1958/champion.json'), 'utf8')
);
const decision = JSON.parse(
  fs.readFileSync(path.resolve('artifacts/arc-agi-3/sot-1958/decision.json'), 'utf8')
);
const targetRegistry = JSON.parse(
  fs.readFileSync(path.resolve('scripts/ai/kaggle_targets_registry.json'), 'utf8')
);
const kernelSource = path.resolve('kaggle/arc-agi-3-gpt-champion/submit.py');

function run(input: string, ...args: string[]) {
  return spawnSync('python3', [executable, ...args], { encoding: 'utf8', input });
}

describe('ARC-AGI-3 champion exec contract', () => {
  it('identifies exactly the registry champion and its confirmed evaluation', () => {
    const result = run('', '--manifest');
    expect(result.status).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest).toMatchObject(registry.champion);
    const evaluation = decision.evaluations.find(
      (item: { fingerprint: string }) =>
        item.fingerprint === registry.champion.evaluationFingerprint
    );
    expect(evaluation).toMatchObject({
      candidate: {
        id: registry.champion.candidateId,
        artifactId: registry.champion.artifactId,
      },
      gate: { screenPassed: true, confirmExecuted: true },
    });
    expect(evaluation.stages.map((stage: { name: string }) => stage.name)).toEqual([
      'screen',
      'confirm',
    ]);
  });

  // arc-agi-3 は kaggle 改善サイクルの完了駆動ループ化に伴い registry から削除済み（biohub+kaggriculture
  // のみ運用）。提出 provenance が registry に無くなったため、この registry 依存アサートは撤去（skip）。
  it.skip('pins the completed cycle-5 GPT champion submission provenance', () => {
    const target = targetRegistry.competitions
      .find((competition: { key: string }) => competition.key === 'arc-agi-3')
      ?.targets.find((item: { repo: string }) => item.repo === 'arc-agi-3-gpt');

    expect(target.submit).toMatchObject({
      kernel: 'sota1111/arc-agi-3-gpt-registered-champion',
      version: 6,
      candidate_id: 'region-effect-full-v1',
      evaluation_fingerprint:
        'sha256:f8f95eb35b88e8de53562f884c2101c16c4d4bd8cf02dca51d17edb56e7c2e01',
      exec_fingerprint: 'kaggle:kernel-v6/submission-55095979',
      source_fingerprint: 'git:e6bba1d461c03856429e0ae19f8116ec3306149b',
      artifact_fingerprint:
        'sha256:c667ea758bf72eab13086ed9f1c29c22b5eb9306b9a0830568cbd5f2995ee0c1',
      submission_ref: 55095979,
      submission_status: 'COMPLETE',
      public_score: 0.0,
    });
    expect(target.champion_status).toBe('exec-verified');
    expect(fs.readFileSync(kernelSource, 'utf8')).not.toContain('champion_agent.py');
  });

  it('runs as a deterministic JSONL subprocess with legal output schema', () => {
    const input = [replay.initial, replay.transitions[0].frame]
      .map((frame: unknown) => JSON.stringify(frame))
      .join('\n');
    const first = run(`${input}\n`);
    const second = run(`${input}\n`);
    expect(first.status).toBe(0);
    expect(second).toEqual(expect.objectContaining({ status: 0, stdout: first.stdout }));
    expect(first.stdout.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      replay.transitions[0].action,
      replay.transitions[1].action,
    ]);
    expect(first.stderr).toBe('');
  });

  it('fails closed on malformed JSON and invalid production input', () => {
    for (const input of [
      '{bad}\n',
      `${JSON.stringify({ ...replay.initial, available_actions: [] })}\n`,
      `${JSON.stringify({ ...replay.initial, levels_completed: -1 })}\n`,
    ]) {
      const result = run(input);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('line 1:');
    }
  });
});
