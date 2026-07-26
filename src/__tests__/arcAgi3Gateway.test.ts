import path from 'node:path';
import { evaluateArcAgi3Candidate, runArcAgi3Episode } from '../lib/arcAgi3Evaluation.js';
import {
  GatewayReplayEnvironment,
  createGatewayAgent,
  parseFrameData,
  parseGameAction,
  readGatewayReplay,
} from '../lib/arcAgi3Gateway.js';

const fixtureFile = path.resolve('src/__fixtures__/arcAgi3GatewayReplay.json');
const replay = readGatewayReplay(fixtureFile);
const agent = createGatewayAgent('gateway-rule-v1', 'git:fixture', (frame) => ({
  action: frame.levels_completed === 0 ? 1 : 4,
}));

describe('ARC-AGI-3 production gateway adapter', () => {
  it('runs production-shaped FrameData to legal GameAction through the episode runner', async () => {
    const episode = await runArcAgi3Episode(new GatewayReplayEnvironment(replay), agent, 1, 10);
    expect(episode).toMatchObject({ score: 2, steps: 2, end: 'terminated' });
  });

  it('is deterministic and runs screen then independent confirm', async () => {
    const plan = {
      runId: 'sot-1999-gateway-contract',
      screenSeeds: [1, 2],
      confirmSeeds: [11, 12, 13],
      maxSteps: 4,
      screenMinimumMean: 2,
    };
    const first = await evaluateArcAgi3Candidate(
      plan,
      () => new GatewayReplayEnvironment(replay),
      agent
    );
    const second = await evaluateArcAgi3Candidate(
      plan,
      () => new GatewayReplayEnvironment(replay),
      agent
    );
    expect(second).toEqual(first);
    expect(first.stages.map((stage) => stage.name)).toEqual(['screen', 'confirm']);
    expect(first.stages.every((stage) => stage.meanScore === 2)).toBe(true);
  });

  it('rejects malformed frames, illegal actions, and malformed ACTION6 coordinates', () => {
    expect(() => parseFrameData({ ...replay.initial, frame: [[[16]]] })).toThrow(
      'frame cells must be integers from 0 to 15'
    );
    expect(() => parseGameAction({ action: 2 }, replay.initial)).toThrow('is not available');
    expect(() => parseGameAction({ action: 6, data: { x: 64, y: 0 } }, replay.initial)).toThrow(
      'ACTION6 requires'
    );
  });

  it('enforces the recorded transition and the episode step limit', async () => {
    const wrongAgent = createGatewayAgent('wrong', 'git:wrong', () => ({ action: 4 }));
    await expect(
      runArcAgi3Episode(new GatewayReplayEnvironment(replay), wrongAgent, 1, 2)
    ).rejects.toThrow('replay expected ACTION1');
    const limited = await runArcAgi3Episode(new GatewayReplayEnvironment(replay), agent, 1, 1);
    expect(limited).toMatchObject({ steps: 1, end: 'step_limit' });
  });
});
