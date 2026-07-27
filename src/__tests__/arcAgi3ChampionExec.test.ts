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
