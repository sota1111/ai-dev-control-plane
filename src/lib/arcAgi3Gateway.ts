import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  type ArcAgi3Agent,
  type ArcAgi3Environment,
  type ArcAgi3Reset,
  type ArcAgi3Step,
} from './arcAgi3Evaluation.js';

export type GameState = 'NOT_STARTED' | 'NOT_FINISHED' | 'WIN' | 'GAME_OVER';
export type GameActionId = 1 | 2 | 3 | 4 | 5 | 6;

export interface ActionInput {
  id: GameActionId;
  x?: number;
  y?: number;
  data?: Record<string, unknown> | null;
  reasoning?: Record<string, unknown> | null;
}

/** JSON shape returned by the production ARC-AGI-3 gateway after RESET/ACTION. */
export interface FrameData {
  game_id: string;
  guid: string;
  frame: number[][][];
  state: GameState;
  levels_completed: number;
  win_levels: number;
  action_input: ActionInput;
  available_actions: GameActionId[];
  full_reset?: boolean;
}

/** JSON representation of an arcengine GameAction plus optional ACTION6 coordinates. */
export interface GameAction {
  action: GameActionId;
  data?: { x: number; y: number };
  reasoning?: Record<string, unknown>;
}

export interface GatewayReplay {
  schemaVersion: 'arc-agi-3-gateway-replay/v1';
  environment: { id: string; version: string };
  initial: FrameData;
  transitions: Array<{ action: GameAction; frame: FrameData }>;
}

export type ReplayCohort = 'screen' | 'confirm';

export interface ReplayProvenance {
  source: 'production' | 'synthetic';
  capturedAt?: string;
  anonymization: string;
  productionEvidence: boolean;
  blockReason?: string;
}

export interface GatewayReplayEpisode {
  id: string;
  cohort: ReplayCohort;
  provenance: ReplayProvenance;
  replay: GatewayReplay;
}

export interface GatewayReplayCorpus {
  schemaVersion: 'arc-agi-3-gateway-replay-corpus/v1';
  corpusId: string;
  episodes: GatewayReplayEpisode[];
}

export interface ReplayTransitionDiagnostic {
  index: number;
  action: GameAction;
  legalAction: boolean;
  changedCells: number;
  levelDelta: number;
  noOp: boolean;
  state: GameState;
}

export interface ReplayEpisodeDiagnostic {
  episodeId: string;
  cohort: ReplayCohort;
  steps: number;
  changedCells: number;
  levelProgress: number;
  noOps: number;
  faults: number;
  termination: 'WIN' | 'GAME_OVER' | 'EXHAUSTED';
  transitions: ReplayTransitionDiagnostic[];
}

export interface ReplayCorpusDiagnostic {
  schemaVersion: 'arc-agi-3-replay-diagnostics/v1';
  corpusId: string;
  corpusFingerprint: string;
  cohorts: { screen: string[]; confirm: string[] };
  totals: {
    episodes: number;
    steps: number;
    changedCells: number;
    levelProgress: number;
    noOps: number;
    faults: number;
    termination: Record<'WIN' | 'GAME_OVER' | 'EXHAUSTED', number>;
  };
  episodes: ReplayEpisodeDiagnostic[];
}

const STATES = new Set<GameState>(['NOT_STARTED', 'NOT_FINISHED', 'WIN', 'GAME_OVER']);

function fail(label: string, message: string): never {
  throw new Error(`${label}: ${message}`);
}

export function parseFrameData(value: unknown, label = 'FrameData'): FrameData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label, 'must be an object');
  const frame = value as Partial<FrameData>;
  if (typeof frame.game_id !== 'string' || !frame.game_id) fail(label, 'game_id is required');
  if (typeof frame.guid !== 'string' || !frame.guid) fail(label, 'guid is required');
  if (!STATES.has(frame.state as GameState)) fail(label, 'state is invalid');
  for (const key of ['levels_completed', 'win_levels'] as const) {
    const item = frame[key];
    if (!Number.isInteger(item) || item! < 0 || item! > 254)
      fail(label, `${key} must be an integer from 0 to 254`);
  }
  if (!Array.isArray(frame.frame) || !frame.frame.length)
    fail(label, 'frame must be a non-empty 3D grid');
  for (const [frameIndex, grid] of frame.frame.entries()) {
    if (!Array.isArray(grid) || !grid.length)
      fail(label, `frame[${frameIndex}] must be a non-empty grid`);
    const width = Array.isArray(grid[0]) ? grid[0].length : 0;
    if (!width) fail(label, `frame[${frameIndex}] rows must not be empty`);
    for (const row of grid) {
      if (!Array.isArray(row) || row.length !== width)
        fail(label, `frame[${frameIndex}] must be rectangular`);
      if (row.some((cell) => !Number.isInteger(cell) || cell < 0 || cell > 15))
        fail(label, 'frame cells must be integers from 0 to 15');
    }
  }
  if (!Array.isArray(frame.available_actions) || !frame.available_actions.length)
    fail(label, 'available_actions must not be empty');
  if (
    frame.available_actions.some((action) => !Number.isInteger(action) || action < 1 || action > 6)
  )
    fail(label, 'available_actions must contain action ids 1 through 6');
  if (
    !frame.action_input ||
    !Number.isInteger(frame.action_input.id) ||
    frame.action_input.id < 1 ||
    frame.action_input.id > 6
  )
    fail(label, 'action_input.id must be an action id from 1 through 6');
  if (frame.full_reset !== undefined && typeof frame.full_reset !== 'boolean')
    fail(label, 'full_reset must be boolean');
  return frame as FrameData;
}

export function parseGameAction(
  value: unknown,
  frame: FrameData,
  label = 'GameAction'
): GameAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label, 'must be an object');
  const action = value as Partial<GameAction>;
  if (!Number.isInteger(action.action) || action.action! < 1 || action.action! > 6)
    fail(label, 'action must be an id from 1 through 6');
  if (!frame.available_actions.includes(action.action as GameActionId))
    fail(label, `ACTION${action.action} is not available`);
  if (action.action === 6) {
    if (
      !action.data ||
      !Number.isInteger(action.data.x) ||
      !Number.isInteger(action.data.y) ||
      action.data.x < 0 ||
      action.data.x > 63 ||
      action.data.y < 0 ||
      action.data.y > 63
    )
      fail(label, 'ACTION6 requires integer x/y coordinates from 0 to 63');
  } else if (action.data !== undefined) {
    fail(label, 'data is only valid for ACTION6');
  }
  return action as GameAction;
}

function sameAction(left: GameAction, right: GameAction): boolean {
  return (
    left.action === right.action &&
    JSON.stringify(left.data ?? null) === JSON.stringify(right.data ?? null)
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintGatewayArtifact(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function changedCellCount(before: number[][][], after: number[][][]): number {
  const cells = (frames: number[][][]) =>
    new Map(
      frames.flatMap((grid, z) =>
        grid.flatMap((row, y) => row.map((cell, x) => [`${z}:${y}:${x}`, cell] as const))
      )
    );
  const left = cells(before);
  const right = cells(after);
  const coordinates = new Set([...left.keys(), ...right.keys()]);
  let changed = 0;
  coordinates.forEach((coordinate) => {
    if (left.get(coordinate) !== right.get(coordinate)) changed += 1;
  });
  return changed;
}

export function validateGatewayReplayCorpus(value: unknown): GatewayReplayCorpus {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('gateway replay corpus must be an object');
  const corpus = value as GatewayReplayCorpus;
  if (corpus.schemaVersion !== 'arc-agi-3-gateway-replay-corpus/v1')
    throw new Error('unsupported gateway replay corpus schema');
  if (!corpus.corpusId || !Array.isArray(corpus.episodes) || corpus.episodes.length < 2)
    throw new Error('gateway replay corpus requires an id and multiple episodes');
  const ids = new Set<string>();
  const gameGuids = new Map<string, ReplayCohort>();
  const cohortCounts = { screen: 0, confirm: 0 };
  corpus.episodes.forEach((episode, index) => {
    const label = `episodes[${index}]`;
    if (!episode.id || ids.has(episode.id)) throw new Error(`${label}: id must be unique`);
    ids.add(episode.id);
    if (episode.cohort !== 'screen' && episode.cohort !== 'confirm')
      throw new Error(`${label}: cohort must be screen or confirm`);
    cohortCounts[episode.cohort] += 1;
    if (!episode.provenance?.anonymization)
      throw new Error(`${label}: provenance.anonymization is required`);
    if (episode.provenance.source === 'production') {
      if (!episode.provenance.productionEvidence || !episode.provenance.capturedAt)
        throw new Error(`${label}: production provenance requires evidence and capturedAt`);
    } else if (episode.provenance.source === 'synthetic') {
      if (episode.provenance.productionEvidence || !episode.provenance.blockReason)
        throw new Error(
          `${label}: synthetic provenance requires a blockReason and no production evidence`
        );
    } else {
      throw new Error(`${label}: provenance.source is invalid`);
    }
    new GatewayReplayEnvironment(episode.replay);
    const key = `${episode.replay.initial.game_id}:${episode.replay.initial.guid}`;
    const existing = gameGuids.get(key);
    if (existing && existing !== episode.cohort)
      throw new Error(`${label}: screen and confirm cohorts overlap at ${key}`);
    gameGuids.set(key, episode.cohort);
  });
  if (!cohortCounts.screen || !cohortCounts.confirm)
    throw new Error('gateway replay corpus requires non-empty screen and confirm cohorts');
  return corpus;
}

export function readGatewayReplayCorpus(file: string): GatewayReplayCorpus {
  return validateGatewayReplayCorpus(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function diagnoseGatewayReplayCorpus(corpus: GatewayReplayCorpus): ReplayCorpusDiagnostic {
  validateGatewayReplayCorpus(corpus);
  const episodes = corpus.episodes.map((episode): ReplayEpisodeDiagnostic => {
    let previous = episode.replay.initial;
    let faults = 0;
    const transitions = episode.replay.transitions.map((transition, index) => {
      let legalAction = true;
      try {
        parseGameAction(transition.action, previous);
      } catch {
        legalAction = false;
        faults += 1;
      }
      const changedCells = changedCellCount(previous.frame, transition.frame.frame);
      const levelDelta = transition.frame.levels_completed - previous.levels_completed;
      previous = transition.frame;
      return {
        index,
        action: transition.action,
        legalAction,
        changedCells,
        levelDelta,
        noOp: changedCells === 0 && levelDelta === 0,
        state: transition.frame.state,
      };
    });
    const finalState = previous.state;
    return {
      episodeId: episode.id,
      cohort: episode.cohort,
      steps: transitions.length,
      changedCells: transitions.reduce((sum, item) => sum + item.changedCells, 0),
      levelProgress: transitions.reduce((sum, item) => sum + item.levelDelta, 0),
      noOps: transitions.filter((item) => item.noOp).length,
      faults,
      termination: finalState === 'WIN' || finalState === 'GAME_OVER' ? finalState : 'EXHAUSTED',
      transitions,
    };
  });
  const termination = { WIN: 0, GAME_OVER: 0, EXHAUSTED: 0 };
  episodes.forEach((episode) => {
    termination[episode.termination] += 1;
  });
  return {
    schemaVersion: 'arc-agi-3-replay-diagnostics/v1',
    corpusId: corpus.corpusId,
    corpusFingerprint: fingerprintGatewayArtifact(corpus),
    cohorts: {
      screen: corpus.episodes.filter((item) => item.cohort === 'screen').map((item) => item.id),
      confirm: corpus.episodes.filter((item) => item.cohort === 'confirm').map((item) => item.id),
    },
    totals: {
      episodes: episodes.length,
      steps: episodes.reduce((sum, item) => sum + item.steps, 0),
      changedCells: episodes.reduce((sum, item) => sum + item.changedCells, 0),
      levelProgress: episodes.reduce((sum, item) => sum + item.levelProgress, 0),
      noOps: episodes.reduce((sum, item) => sum + item.noOps, 0),
      faults: episodes.reduce((sum, item) => sum + item.faults, 0),
      termination,
    },
    episodes,
  };
}

/** Replays recorded production-shaped frames through the generic episode runner. */
export class GatewayReplayEnvironment implements ArcAgi3Environment<GameAction, FrameData> {
  readonly environmentId: string;
  readonly environmentVersion: string;
  private index = 0;
  private current: FrameData;

  constructor(private readonly replay: GatewayReplay) {
    if (replay.schemaVersion !== 'arc-agi-3-gateway-replay/v1')
      throw new Error('unsupported gateway replay schema');
    this.environmentId = replay.environment.id;
    this.environmentVersion = replay.environment.version;
    this.current = parseFrameData(replay.initial, 'initial');
    replay.transitions.forEach((transition, index) => {
      parseGameAction(
        transition.action,
        index ? replay.transitions[index - 1].frame : replay.initial
      );
      parseFrameData(transition.frame, `transitions[${index}].frame`);
    });
  }

  reset(_seed: number): ArcAgi3Reset<FrameData> {
    this.index = 0;
    this.current = this.replay.initial;
    return { observation: this.current };
  }

  step(action: GameAction): ArcAgi3Step<FrameData> {
    const validated = parseGameAction(action, this.current);
    const transition = this.replay.transitions[this.index];
    if (!transition) throw new Error('replay has no remaining transition');
    if (!sameAction(validated, transition.action))
      throw new Error(`replay expected ACTION${transition.action.action}`);
    const previousLevels = this.current.levels_completed;
    this.current = transition.frame;
    this.index += 1;
    return {
      observation: this.current,
      reward: this.current.levels_completed - previousLevels,
      terminated: this.current.state === 'WIN' || this.current.state === 'GAME_OVER',
      info: { state: this.current.state },
    };
  }
}

export function readGatewayReplay(file: string): GatewayReplay {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as GatewayReplay;
  // Constructor validates the complete fixture before it is exposed.
  new GatewayReplayEnvironment(value);
  return value;
}

export function createGatewayAgent(
  candidateId: string,
  artifactId: string,
  chooseAction: (frame: Readonly<FrameData>) => GameAction | Promise<GameAction>
): ArcAgi3Agent<GameAction, FrameData> {
  return {
    candidateId,
    artifactId,
    act: async ({ observation }) => parseGameAction(await chooseAction(observation), observation),
  };
}
