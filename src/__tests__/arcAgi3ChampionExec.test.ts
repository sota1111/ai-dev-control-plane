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

  it('pins the completed external GPT champion and submission provenance', () => {
    const target = targetRegistry.competitions
      .find((competition: { key: string }) => competition.key === 'arc-agi-3')
      .targets.find((item: { repo: string }) => item.repo === 'arc-agi-3-gpt');

    expect(target.submit).toMatchObject({
      kernel: 'sota1111/arc-agi-3-gpt-registered-champion',
      version: 5,
      candidate_id: 'deterministic-legal-v1',
      evaluation_fingerprint:
        'sha256:6f68d6305ae64de7686cbcd81ddeb300b2861080f4ed3436740169ea868c1aa2',
      exec_fingerprint: 'kaggle:kernel-v5/submission-55067146',
      source_fingerprint: 'git:7a145f8d68a93c09a51c69a2bce96388f7cba632',
      artifact_fingerprint:
        'sha256:d734c42fd993c667af50724868096884f941b751855669db6298e6107d4a5520',
      submission_ref: 55067146,
      submission_status: 'COMPLETE',
      public_score: 0.08,
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
