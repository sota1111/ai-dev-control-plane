import fs from 'node:fs';
import path from 'node:path';
import { evaluateArcAgi3Candidate, runArcAgi3Episode } from '../lib/arcAgi3Evaluation.js';
import {
  GatewayReplayEnvironment,
  createGatewayAgent,
  diagnoseGatewayReplayCorpus,
  fingerprintGatewayArtifact,
  parseFrameData,
  parseGameAction,
  readGatewayReplay,
  readGatewayReplayCorpus,
  validateGatewayReplayCorpus,
} from '../lib/arcAgi3Gateway.js';

const fixtureFile = path.resolve('src/__fixtures__/arcAgi3GatewayReplay.json');
const replay = readGatewayReplay(fixtureFile);
const corpus = readGatewayReplayCorpus(
  path.resolve('src/__fixtures__/arcAgi3GatewayReplayCorpus.json')
);
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

  it('fixes disjoint screen and confirm replay cohorts with explicit provenance', () => {
    expect(corpus.episodes).toHaveLength(4);
    expect(corpus.episodes.map((episode) => episode.replay.initial.game_id)).toHaveLength(
      new Set(corpus.episodes.map((episode) => episode.replay.initial.game_id)).size
    );
    expect(
      corpus.episodes.every((episode) => episode.provenance.productionEvidence === false)
    ).toBe(true);
    expect(corpus.episodes.every((episode) => Boolean(episode.provenance.blockReason))).toBe(true);
  });

  it('aggregates deterministic action-effect diagnostics across WIN and GAME_OVER', () => {
    const first = diagnoseGatewayReplayCorpus(corpus);
    const second = diagnoseGatewayReplayCorpus(corpus);
    expect(second).toEqual(first);
    expect(first.cohorts).toEqual({
      screen: ['screen-ls20-episode-a', 'screen-ft09-episode-b'],
      confirm: ['confirm-ls20-episode-c', 'confirm-vc33-episode-d'],
    });
    expect(first.totals).toEqual({
      episodes: 4,
      steps: 6,
      changedCells: 10,
      levelProgress: 4,
      noOps: 1,
      faults: 0,
      termination: { WIN: 3, GAME_OVER: 1, EXHAUSTED: 0 },
    });
    expect(
      first.episodes.flatMap((episode) => episode.transitions).every((step) => step.legalAction)
    ).toBe(true);
  });

  it('rejects cohort overlap and provenance that mislabels synthetic data', () => {
    const overlapping = structuredClone(corpus);
    overlapping.episodes[2].replay.initial.game_id = overlapping.episodes[0].replay.initial.game_id;
    overlapping.episodes[2].replay.initial.guid = overlapping.episodes[0].replay.initial.guid;
    expect(() => validateGatewayReplayCorpus(overlapping)).toThrow('cohorts overlap');

    const mislabeled = structuredClone(corpus);
    mislabeled.episodes[0].provenance.productionEvidence = true;
    expect(() => validateGatewayReplayCorpus(mislabeled)).toThrow(
      'synthetic provenance requires a blockReason and no production evidence'
    );
  });

  it('pins the champion and corpus artifact fingerprints in the production-contract baseline', () => {
    const baseline = JSON.parse(
      fs.readFileSync(
        path.resolve('artifacts/arc-agi-3/sot-2084/production-contract-baseline.json'),
        'utf8'
      )
    );
    const champion = JSON.parse(
      fs.readFileSync(path.resolve('artifacts/arc-agi-3/sot-1958/champion.json'), 'utf8')
    );
    expect(baseline.candidate.id).toBe('observation-rule-v1');
    expect(baseline.candidate.championRegistryFingerprint).toBe(
      fingerprintGatewayArtifact(champion)
    );
    expect(baseline.corpus.fingerprint).toBe(diagnoseGatewayReplayCorpus(corpus).corpusFingerprint);
    expect(baseline.gate).toMatchObject({
      promotionDecision: 'not-run',
      kaggleProof: 'blocked-until-authenticated-production-confirm',
    });
  });
});
