import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARC_AGI_3_CHAMPION_SCHEMA,
  ARC_AGI_3_EVALUATION_SCHEMA,
  createChampionRegistry,
  evaluateArcAgi3Candidate,
  promoteChampion,
  runArcAgi3Episode,
  writeChampionRegistry,
  writeEvaluationArtifact,
  type ArcAgi3Agent,
  type ArcAgi3Environment,
} from '../lib/arcAgi3Evaluation.js';

type Observation = { value: number };
type Action = { add: number };

class FixtureEnvironment implements ArcAgi3Environment<Action, Observation> {
  readonly environmentId = 'fixture-counter';
  readonly environmentVersion = '1.0.0';
  private value = 0;
  reset(seed: number) {
    this.value = seed % 3;
    return { observation: { value: this.value } };
  }
  step(action: Action) {
    this.value += action.add;
    return {
      observation: { value: this.value },
      reward: this.value,
      terminated: this.value >= 4,
    };
  }
}

const agent: ArcAgi3Agent<Action, Observation> = {
  candidateId: 'counter-v1',
  artifactId: 'git:0123456',
  act: ({ observation }) => ({ add: observation.value % 2 === 0 ? 1 : 2 }),
};

const plan = {
  runId: 'sot-1957-fixture',
  screenSeeds: [10, 11],
  confirmSeeds: [20, 21],
  maxSteps: 4,
  screenMinimumMean: 1,
};

describe('ARC-AGI-3 evaluation harness', () => {
  it('is byte-reproducible for fixed seeds and records termination and aggregates', async () => {
    const first = await evaluateArcAgi3Candidate(plan, () => new FixtureEnvironment(), agent);
    const second = await evaluateArcAgi3Candidate(plan, () => new FixtureEnvironment(), agent);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.schemaVersion).toBe(ARC_AGI_3_EVALUATION_SCHEMA);
    expect(first.stages).toHaveLength(2);
    expect(
      first.stages.flatMap((stage) => stage.episodes).every((episode) => episode.steps <= 4)
    ).toBe(true);
    expect(first.stages[0].meanScore).toBe(
      first.stages[0].episodes.reduce((sum, episode) => sum + episode.score, 0) / 2
    );
  });

  it('enforces step limits and skips confirm when screen fails', async () => {
    const endless: ArcAgi3Environment<Action, Observation> = {
      environmentId: 'endless',
      environmentVersion: '1',
      reset: () => ({ observation: { value: 0 } }),
      step: () => ({ observation: { value: 0 }, reward: 0, terminated: false }),
    };
    const episode = await runArcAgi3Episode(endless, agent, 1, 2);
    expect(episode).toMatchObject({ end: 'step_limit', steps: 2 });
    const result = await evaluateArcAgi3Candidate(
      { ...plan, screenMinimumMean: 999 },
      () => new FixtureEnvironment(),
      agent
    );
    expect(result.stages.map((stage) => stage.name)).toEqual(['screen']);
    expect(result.gate).toMatchObject({ screenPassed: false, confirmExecuted: false });
  });

  it('rejects overlapping screen/confirm seeds', async () => {
    await expect(
      evaluateArcAgi3Candidate(
        { ...plan, confirmSeeds: [11] },
        () => new FixtureEnvironment(),
        agent
      )
    ).rejects.toThrow('must be disjoint');
  });

  it('persists evaluation evidence and a champion bound to its fingerprint', async () => {
    const evaluation = await evaluateArcAgi3Candidate(plan, () => new FixtureEnvironment(), agent);
    const registry = promoteChampion(
      createChampionRegistry(evaluation),
      evaluation,
      '2026-07-25T00:00:00.000Z'
    );
    expect(registry).toMatchObject({
      schemaVersion: ARC_AGI_3_CHAMPION_SCHEMA,
      champion: {
        candidateId: 'counter-v1',
        artifactId: 'git:0123456',
        evaluationFingerprint: evaluation.fingerprint,
      },
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-agi-3-'));
    const evidenceFile = path.join(directory, 'evidence.json');
    const registryFile = path.join(directory, 'champion.json');
    writeEvaluationArtifact(evidenceFile, evaluation);
    writeChampionRegistry(registryFile, registry);
    expect(JSON.parse(fs.readFileSync(evidenceFile, 'utf8'))).toEqual(evaluation);
    expect(JSON.parse(fs.readFileSync(registryFile, 'utf8'))).toEqual(registry);
  });
});
