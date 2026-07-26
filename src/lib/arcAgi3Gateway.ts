import fs from 'node:fs';
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
