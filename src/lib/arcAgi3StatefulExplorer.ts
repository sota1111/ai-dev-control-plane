import {
  fingerprintGatewayArtifact,
  parseGameAction,
  type FrameData,
  type GameAction,
  type GatewayReplayCorpus,
  type ReplayCohort,
} from './arcAgi3Gateway.js';

interface ActionEffect {
  attempts: number;
  effective: number;
  noOps: number;
}

interface ExplorerState {
  episodeKey: string;
  previousFrame?: FrameData;
  previousAction?: GameAction;
  effects: Map<number, ActionEffect>;
  attempted: Set<string>;
  step: number;
}

export interface ExplorerSnapshot {
  episodeKey: string;
  step: number;
  effects: Record<string, ActionEffect>;
  attempted: string[];
}

export interface ReplayPolicy {
  readonly id: string;
  reset(): void;
  choose(frame: Readonly<FrameData>): GameAction;
  snapshot(): ExplorerSnapshot;
}

export interface PolicyEpisodeResult {
  episodeId: string;
  cohort: ReplayCohort;
  levelProgress: number;
  noOps: number;
  steps: number;
  faults: number;
  termination: 'WIN' | 'GAME_OVER' | 'ACTION_MISMATCH' | 'STEP_LIMIT';
  actions: GameAction[];
}

export interface PolicyCohortResult {
  cohort: ReplayCohort;
  episodeIds: string[];
  levelProgress: number;
  noOps: number;
  steps: number;
  faults: number;
  actionMismatches: number;
  noOpRate: number;
  episodes: PolicyEpisodeResult[];
}

const frameDifference = (before: FrameData, after: FrameData): number => {
  const left = before.frame.flat(2);
  const right = after.frame.flat(2);
  const length = Math.max(left.length, right.length);
  let changed = 0;
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) changed += 1;
  }
  return changed;
};

const actionKey = (action: GameAction): string =>
  action.action === 6 ? `6:${action.data?.x}:${action.data?.y}` : String(action.action);

const coordinateCandidates = (frame: Readonly<FrameData>): Array<{ x: number; y: number }> => {
  const height = Math.min(64, Math.max(...frame.frame.map((grid) => grid.length)));
  const width = Math.min(
    64,
    Math.max(...frame.frame.flatMap((grid) => grid.map((row) => row.length)))
  );
  const candidates: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) candidates.push({ x, y });
  }
  return candidates;
};

/**
 * Stateful, deterministic production-contract explorer.
 *
 * It learns only from consecutive FrameData observations: effective actions are reused, immediate
 * no-ops are avoided, and unseen legal actions/coordinates win deterministic ties.
 */
export function createStatefulFrameDifferenceExplorer(): ReplayPolicy {
  let state: ExplorerState = {
    episodeKey: '',
    effects: new Map(),
    attempted: new Set(),
    step: 0,
  };

  const reset = () => {
    state = { episodeKey: '', effects: new Map(), attempted: new Set(), step: 0 };
  };

  const choose = (frame: Readonly<FrameData>): GameAction => {
    const episodeKey = `${frame.game_id}:${frame.guid}`;
    if (frame.full_reset || state.episodeKey !== episodeKey) {
      state = { episodeKey, effects: new Map(), attempted: new Set(), step: 0 };
    }

    if (state.previousFrame && state.previousAction) {
      const effect = state.effects.get(state.previousAction.action) ?? {
        attempts: 0,
        effective: 0,
        noOps: 0,
      };
      const effective =
        frameDifference(state.previousFrame, frame) > 0 ||
        frame.levels_completed > state.previousFrame.levels_completed;
      effect.attempts += 1;
      if (effective) effect.effective += 1;
      else effect.noOps += 1;
      state.effects.set(state.previousAction.action, effect);
    }

    const candidates = frame.available_actions.flatMap((action): GameAction[] => {
      if (action !== 6) return [{ action }];
      const echoed =
        frame.action_input.id === 6 &&
        Number.isInteger(frame.action_input.x) &&
        Number.isInteger(frame.action_input.y)
          ? [{ x: frame.action_input.x!, y: frame.action_input.y! }]
          : [];
      return [...echoed, ...coordinateCandidates(frame)].map((data) => ({ action: 6, data }));
    });

    const ranked = candidates
      .map((action, index) => {
        const effect = state.effects.get(action.action);
        const tried = state.attempted.has(actionKey(action));
        const immediateNoOp =
          state.previousAction?.action === action.action &&
          (state.effects.get(action.action)?.noOps ?? 0) > 0;
        const echoed =
          action.action === frame.action_input.id &&
          (action.action !== 6 ||
            (action.data?.x === frame.action_input.x && action.data?.y === frame.action_input.y));
        return {
          action,
          index,
          score: [
            immediateNoOp ? 0 : 1,
            echoed ? 1 : 0,
            effect?.effective ? 1 : 0,
            tried ? 0 : 1,
            effect ? effect.effective / effect.attempts : 0,
            -index,
          ],
        };
      })
      .sort((left, right) => {
        for (let index = 0; index < left.score.length; index += 1) {
          if (left.score[index] !== right.score[index])
            return right.score[index] - left.score[index];
        }
        return 0;
      });

    const selected = parseGameAction(ranked[0].action, frame);
    state.attempted.add(actionKey(selected));
    state.previousFrame = frame as FrameData;
    state.previousAction = selected;
    state.step += 1;
    return selected;
  };

  return {
    id: 'stateful-frame-difference-v1',
    reset,
    choose,
    snapshot: () => ({
      episodeKey: state.episodeKey,
      step: state.step,
      effects: Object.fromEntries(
        [...state.effects.entries()].map(([action, effect]) => [String(action), { ...effect }])
      ),
      attempted: [...state.attempted].sort(),
    }),
  };
}

export function createObservationEchoIncumbent(): ReplayPolicy {
  let episodeKey = '';
  let step = 0;
  return {
    id: 'observation-rule-v1',
    reset: () => {
      episodeKey = '';
      step = 0;
    },
    choose: (frame) => {
      episodeKey = `${frame.game_id}:${frame.guid}`;
      step += 1;
      const action: GameAction =
        frame.action_input.id === 6
          ? {
              action: 6,
              data: { x: frame.action_input.x ?? 0, y: frame.action_input.y ?? 0 },
            }
          : { action: frame.action_input.id };
      return parseGameAction(action, frame);
    },
    snapshot: () => ({ episodeKey, step, effects: {}, attempted: [] }),
  };
}

export function evaluateReplayPolicy(
  corpus: GatewayReplayCorpus,
  cohort: ReplayCohort,
  policyFactory: () => ReplayPolicy,
  maxSteps = 200
): PolicyCohortResult {
  const episodes = corpus.episodes
    .filter((episode) => episode.cohort === cohort)
    .map((episode): PolicyEpisodeResult => {
      const policy = policyFactory();
      policy.reset();
      let current = episode.replay.initial;
      let levelProgress = 0;
      let noOps = 0;
      let faults = 0;
      const actions: GameAction[] = [];
      let termination: PolicyEpisodeResult['termination'] = 'STEP_LIMIT';
      for (
        let index = 0;
        index < episode.replay.transitions.length && index < maxSteps;
        index += 1
      ) {
        let action: GameAction;
        try {
          action = parseGameAction(policy.choose(current), current);
        } catch {
          faults += 1;
          termination = 'ACTION_MISMATCH';
          break;
        }
        actions.push(action);
        const transition = episode.replay.transitions[index];
        if (fingerprintGatewayArtifact(action) !== fingerprintGatewayArtifact(transition.action)) {
          termination = 'ACTION_MISMATCH';
          break;
        }
        const before = current;
        current = transition.frame;
        levelProgress += current.levels_completed - before.levels_completed;
        if (
          frameDifference(before, current) === 0 &&
          current.levels_completed === before.levels_completed
        )
          noOps += 1;
        if (current.state === 'WIN' || current.state === 'GAME_OVER') {
          termination = current.state;
          break;
        }
      }
      return {
        episodeId: episode.id,
        cohort,
        levelProgress,
        noOps,
        steps: actions.length,
        faults,
        termination,
        actions,
      };
    });
  const steps = episodes.reduce((sum, episode) => sum + episode.steps, 0);
  const noOps = episodes.reduce((sum, episode) => sum + episode.noOps, 0);
  return {
    cohort,
    episodeIds: episodes.map((episode) => episode.episodeId),
    levelProgress: episodes.reduce((sum, episode) => sum + episode.levelProgress, 0),
    noOps,
    steps,
    faults: episodes.reduce((sum, episode) => sum + episode.faults, 0),
    actionMismatches: episodes.filter(
      (episode) => episode.termination === 'ACTION_MISMATCH'
    ).length,
    noOpRate: steps ? noOps / steps : 0,
    episodes,
  };
}
