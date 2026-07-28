import fs from 'node:fs';
import path from 'node:path';
import { readGatewayReplayCorpus, type FrameData } from '../lib/arcAgi3Gateway.js';
import {
  createObservationEchoIncumbent,
  createStatefulFrameDifferenceExplorer,
  evaluateReplayPolicy,
} from '../lib/arcAgi3StatefulExplorer.js';

const corpus = readGatewayReplayCorpus(
  path.join(process.cwd(), 'src/__fixtures__/arcAgi3GatewayReplayCorpus.json')
);

describe('stateful ARC-AGI-3 explorer candidate', () => {
  it('uses frame effects and avoids repeating an immediate no-op deterministically', () => {
    const replay = corpus.episodes.find((episode) => episode.id === 'screen-ft09-episode-b')!.replay;
    const first = createStatefulFrameDifferenceExplorer();
    const second = createStatefulFrameDifferenceExplorer();
    expect(first.choose(replay.initial)).toEqual({ action: 2 });
    expect(second.choose(replay.initial)).toEqual({ action: 2 });
    expect(first.choose(replay.transitions[0].frame)).toEqual({ action: 3 });
    expect(second.choose(replay.transitions[0].frame)).toEqual({ action: 3 });
    expect(first.snapshot().effects['2']).toEqual({ attempts: 1, effective: 0, noOps: 1 });
  });

  it('resets state across episodes and full reset frames', () => {
    const agent = createStatefulFrameDifferenceExplorer();
    const first = corpus.episodes[1].replay;
    agent.choose(first.initial);
    agent.choose(first.transitions[0].frame);
    const other = corpus.episodes[0].replay.initial;
    expect(agent.choose(other)).toEqual({ action: 1 });
    expect(agent.snapshot().step).toBe(1);
    expect(agent.choose({ ...other, full_reset: true })).toEqual({ action: 1 });
    expect(agent.snapshot().step).toBe(1);
  });

  it('uses valid deterministic coordinates and enforces gateway bounds', () => {
    const agent = createStatefulFrameDifferenceExplorer();
    const frame = corpus.episodes.find((episode) => episode.id === 'confirm-vc33-episode-d')!.replay
      .initial;
    expect(agent.choose(frame)).toEqual({ action: 6, data: { x: 1, y: 1 } });
    const wide: FrameData = {
      ...frame,
      guid: 'wide',
      action_input: { id: 5 },
      available_actions: [6],
      frame: [Array.from({ length: 70 }, () => Array.from({ length: 70 }, () => 0))],
    };
    const coordinate = agent.choose(wide);
    expect(coordinate.action).toBe(6);
    expect(coordinate.data!.x).toBeGreaterThanOrEqual(0);
    expect(coordinate.data!.x).toBeLessThanOrEqual(63);
    expect(coordinate.data!.y).toBeGreaterThanOrEqual(0);
    expect(coordinate.data!.y).toBeLessThanOrEqual(63);
  });

  it('screens on the fixed cohort before evaluating independent confirm episodes', () => {
    const incumbent = evaluateReplayPolicy(corpus, 'screen', createObservationEchoIncumbent, 8);
    const candidate = evaluateReplayPolicy(
      corpus,
      'screen',
      createStatefulFrameDifferenceExplorer,
      8
    );
    expect(candidate.episodeIds).not.toEqual(
      corpus.episodes.filter((episode) => episode.cohort === 'confirm').map((episode) => episode.id)
    );
    expect(candidate.levelProgress).toBeGreaterThanOrEqual(incumbent.levelProgress);
    expect(candidate.noOpRate).toBeLessThanOrEqual(incumbent.noOpRate);
    expect(candidate.actionMismatches).toBeLessThan(incumbent.actionMismatches);
    expect(candidate.faults).toBe(0);

    const confirm = evaluateReplayPolicy(
      corpus,
      'confirm',
      createStatefulFrameDifferenceExplorer,
      8
    );
    expect(new Set(confirm.episodeIds)).toEqual(
      new Set(['confirm-ls20-episode-c', 'confirm-vc33-episode-d'])
    );
    expect(confirm.levelProgress).toBe(3);
    expect(confirm.faults).toBe(0);
    expect(confirm.episodes.every((episode) => episode.termination === 'WIN')).toBe(true);
  });

  it('honours a step cap and uses only legal fallback actions', () => {
    const result = evaluateReplayPolicy(corpus, 'screen', createStatefulFrameDifferenceExplorer, 1);
    expect(result.steps).toBe(2);
    expect(result.episodes[1].termination).toBe('STEP_LIMIT');
    expect(result.faults).toBe(0);
    expect(
      result.episodes.every((episode) =>
        episode.actions.every((action) => action.action >= 1 && action.action <= 6)
      )
    ).toBe(true);
  });

  it('keeps the corpus fixture immutable while evaluating', () => {
    const file = path.join(process.cwd(), 'src/__fixtures__/arcAgi3GatewayReplayCorpus.json');
    const before = fs.readFileSync(file, 'utf8');
    evaluateReplayPolicy(corpus, 'screen', createStatefulFrameDifferenceExplorer);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});
