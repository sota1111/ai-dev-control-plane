import {
  BaselineContractEnvironment,
  createObservationRule,
  createRandomControl,
  evaluateInitialBaselines,
} from '../lib/arcAgi3Baselines.js';
import { runArcAgi3Episode } from '../lib/arcAgi3Evaluation.js';

const plan = {
  runId: 'sot-1958-test',
  screenSeeds: [101, 102, 103, 104],
  confirmSeeds: [201, 202, 203, 204, 205, 206],
  maxSteps: 4,
  screenMinimumMean: 3,
};

describe('ARC-AGI-3 initial baselines', () => {
  it('keeps every candidate action legal and within the step limit', async () => {
    for (const agent of [createRandomControl('git:test'), createObservationRule('git:test')]) {
      const episode = await runArcAgi3Episode(
        new BaselineContractEnvironment(),
        agent,
        17,
        plan.maxSteps
      );
      expect(episode.steps).toBeLessThanOrEqual(plan.maxSteps);
      expect(episode.end).toBe('terminated');
    }
    const environment = new BaselineContractEnvironment();
    environment.reset(1);
    expect(() => environment.step({ choice: 99 })).toThrow('illegal action');
  });

  it('screens the control, confirms only passing candidates, and promotes the rule', async () => {
    const result = await evaluateInitialBaselines(
      'git:0123456789',
      '2026-07-25T23:00:00.000Z',
      plan
    );
    const [control, rule] = result.evaluations;
    expect(control.candidate.id).toBe('random-control-v1');
    expect(control.gate.confirmExecuted).toBe(false);
    expect(rule.stages.map((stage) => stage.name)).toEqual(['screen', 'confirm']);
    expect(rule.stages[1].seeds).toEqual(plan.confirmSeeds);
    expect(result.promotion.candidateId).toBe('observation-rule-v1');
    expect(result.championRegistry.champion).toMatchObject({
      candidateId: 'observation-rule-v1',
      artifactId: 'git:0123456789',
      evaluationFingerprint: rule.fingerprint,
    });
  });

  it('does not update the registry when the confirm promotion threshold is unmet', async () => {
    const result = await evaluateInitialBaselines('git:test', '2026-07-25T23:00:00.000Z', plan, 5);
    expect(result.promotion.candidateId).toBeNull();
    expect(result.championRegistry.champion).toBeNull();
  });
});
