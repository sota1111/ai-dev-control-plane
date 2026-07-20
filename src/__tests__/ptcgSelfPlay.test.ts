import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MatchManager,
  SELF_PLAY_JOB_SCHEMA,
  createCheckpoint,
  deriveMatchSeed,
  loadCheckpoint,
  matchIdFor,
  saveCheckpoint,
  validateSelfPlayJob,
  type EnvironmentWorker,
  type SelfPlayJob,
} from '../lib/ptcgSelfPlay.js';

const job: SelfPlayJob = {
  schemaVersion: SELF_PLAY_JOB_SCHEMA,
  runId: 'run.training.0001',
  seed: 1772,
  matches: 4,
  contestants: { first: 'submission.matsu', second: 'submission.take' },
  versions: { engine: 'cabt-1', environment: 'arena-1' },
};

function worker(mode: EnvironmentWorker['mode'], calls: number[]): EnvironmentWorker {
  return {
    mode,
    async play(input) {
      calls.push(input.matchIndex);
      return { result: { winner: input.seed % 2 ? 'first' : 'second' } };
    },
  };
}

describe('resumable PTCG self-play', () => {
  it('uses one validated job contract for local and distributed workers', async () => {
    expect(validateSelfPlayJob(job)).toEqual([]);
    const local = await new MatchManager(job).run(worker('local', []));
    const distributed = await new MatchManager(job).run(worker('distributed', []));
    expect(distributed).toEqual(local);
  });

  it('derives reproducible per-match seeds and results', async () => {
    expect(deriveMatchSeed(1772, 2)).toBe(deriveMatchSeed(1772, 2));
    expect(deriveMatchSeed(1772, 2)).not.toBe(deriveMatchSeed(1772, 3));
    const first = await new MatchManager(job).run(worker('local', []));
    const replay = await new MatchManager(job).run(worker('local', []));
    expect(replay.completed.map((match) => match.result)).toEqual(
      first.completed.map((match) => match.result)
    );
  });

  it('resumes from an atomic checkpoint without replaying completed matches', async () => {
    const initial = new MatchManager(job);
    const firstMatchId = matchIdFor(job.runId, 0);
    initial.register({
      matchId: firstMatchId,
      runId: job.runId,
      index: 0,
      seed: deriveMatchSeed(job.seed, 0),
      result: { winner: 'first' },
      artifact: {
        schemaVersion: 'ptcg-self-play-artifact/v1',
        runId: job.runId,
        matchId: firstMatchId,
        parentArtifactId: null,
        artifactId: `${firstMatchId}.result`,
      },
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-self-play-'));
    const file = path.join(directory, 'checkpoint.json');
    saveCheckpoint(file, initial.checkpoint());
    const calls: number[] = [];
    const resumed = await new MatchManager(job, loadCheckpoint(file, job)).run(
      worker('distributed', calls)
    );
    expect(calls).toEqual([1, 2, 3]);
    expect(resumed.completed).toHaveLength(4);
  });

  it('deduplicates identical registration and rejects conflicts', async () => {
    const completed = await new MatchManager({ ...job, matches: 1 }).run(worker('local', []));
    const manager = new MatchManager({ ...job, matches: 1 }, completed);
    expect(manager.register(completed.completed[0])).toBe(false);
    expect(() =>
      manager.register({ ...completed.completed[0], result: { winner: 'draw' } })
    ).toThrow('conflicting result');
  });

  it('stores run and match lineage on every artifact', async () => {
    const checkpoint = await new MatchManager({ ...job, matches: 1 }).run({
      mode: 'local',
      async play() {
        return {
          result: 'draw',
          artifactId: 'artifact.result.1',
          parentArtifactId: 'artifact.model.9',
        };
      },
    });
    expect(checkpoint.completed[0].artifact).toMatchObject({
      runId: job.runId,
      matchId: matchIdFor(job.runId, 0),
      artifactId: 'artifact.result.1',
      parentArtifactId: 'artifact.model.9',
    });
  });

  it('rejects a checkpoint from a different job', () => {
    const checkpoint = createCheckpoint(job);
    expect(() => new MatchManager({ ...job, seed: 9 }, checkpoint)).toThrow('does not match');
  });
});
