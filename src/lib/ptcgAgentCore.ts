import type { MatchFault, Seat } from './ptcgLeagueContract.js';

export const PTCG_AGENT_CONFIG_VERSION = 'ptcg-agent-core/v2' as const;
export const SUPPORTED_PTCG_AGENT_CONFIG_VERSIONS = [
  'ptcg-agent-core/v1',
  PTCG_AGENT_CONFIG_VERSION,
] as const;

export type PtcgAgentId = 'matsu' | 'take' | 'ume' | 'zero';

export interface PtcgAgentCoreConfigV1 {
  schemaVersion: 'ptcg-agent-core/v1';
  agentId: PtcgAgentId;
  entrypoint: string;
  seed?: number;
  timeoutMs?: number;
}

export interface PtcgAgentCoreConfig {
  schemaVersion: typeof PTCG_AGENT_CONFIG_VERSION;
  agent: { id: PtcgAgentId; entrypoint: string };
  runtime: { seed: number; timeoutMs: number; maxRetries: number };
  compatibility: { adapterApi: 'ptcg-agent-adapter/v1' };
}

export const PTCG_AGENT_CONFIG_DEFAULTS = Object.freeze({
  seed: 0,
  timeoutMs: 30_000,
  maxRetries: 0,
});

export const PTCG_ENVIRONMENT_SCHEMA_VERSION = 'ptcg-environment/v1' as const;

export interface PtcgEnvironmentAction {
  id: string;
  kind: 'play-card' | 'attack' | 'pass';
  source?: string;
  target?: string;
}

export interface PtcgEnvironmentObservation {
  schemaVersion: typeof PTCG_ENVIRONMENT_SCHEMA_VERSION;
  seat: Seat;
  turn: number;
  publicState: {
    active: Record<Seat, string>;
    prizeCount: Record<Seat, number>;
    opponentHandCount: number;
  };
  privateState: { hand: string[]; deckCount: number };
  actionSpace: PtcgEnvironmentAction[];
  legalActionIds: string[];
  legalActionMask: boolean[];
}

/** Strictly validates the algorithm-independent environment boundary. */
export function validatePtcgEnvironmentObservation(value: unknown): PtcgEnvironmentObservation {
  const root = record(value, 'observation');
  exactKeys(
    root,
    [
      'schemaVersion',
      'seat',
      'turn',
      'publicState',
      'privateState',
      'actionSpace',
      'legalActionIds',
      'legalActionMask',
    ],
    'observation'
  );
  if (root.schemaVersion !== PTCG_ENVIRONMENT_SCHEMA_VERSION) {
    throw new Error(`observation schemaVersion must be ${PTCG_ENVIRONMENT_SCHEMA_VERSION}`);
  }
  if (root.seat !== 'first' && root.seat !== 'second')
    throw new Error('observation.seat is invalid');
  const publicState = record(root.publicState, 'observation.publicState');
  exactKeys(publicState, ['active', 'prizeCount', 'opponentHandCount'], 'observation.publicState');
  const privateState = record(root.privateState, 'observation.privateState');
  exactKeys(privateState, ['hand', 'deckCount'], 'observation.privateState');
  if (
    !Array.isArray(privateState.hand) ||
    !privateState.hand.every((card) => typeof card === 'string')
  ) {
    throw new Error('observation.privateState.hand must be a string array');
  }
  const actions = root.actionSpace;
  if (!Array.isArray(actions)) throw new Error('observation.actionSpace must be an array');
  const actionSpace = actions.map((candidate, index) => {
    const action = record(candidate, `observation.actionSpace[${index}]`);
    exactKeys(action, ['id', 'kind', 'source', 'target'], `observation.actionSpace[${index}]`);
    if (!['play-card', 'attack', 'pass'].includes(String(action.kind))) {
      throw new Error(`observation.actionSpace[${index}].kind is invalid`);
    }
    return action as unknown as PtcgEnvironmentAction;
  });
  const ids = actionSpace.map((action) => nonEmpty(action.id, 'action.id'));
  if (new Set(ids).size !== ids.length)
    throw new Error('observation.actionSpace ids must be unique');
  if (
    !Array.isArray(root.legalActionIds) ||
    !root.legalActionIds.every((id) => typeof id === 'string')
  ) {
    throw new Error('observation.legalActionIds must be a string array');
  }
  if (
    !Array.isArray(root.legalActionMask) ||
    !root.legalActionMask.every((bit) => typeof bit === 'boolean')
  ) {
    throw new Error('observation.legalActionMask must be a boolean array');
  }
  if (root.legalActionMask.length !== actionSpace.length) {
    throw new Error('observation.legalActionMask length must match actionSpace');
  }
  const maskedIds = ids.filter((_, index) => (root.legalActionMask as boolean[])[index]);
  if (
    new Set(root.legalActionIds).size !== root.legalActionIds.length ||
    root.legalActionIds.some((id) => !ids.includes(id)) ||
    maskedIds.length !== root.legalActionIds.length ||
    maskedIds.some((id) => !(root.legalActionIds as string[]).includes(id))
  ) {
    throw new Error('observation legalActionIds must exactly match legalActionMask');
  }
  nonNegativeInteger(root.turn, 'observation.turn');
  nonNegativeInteger(publicState.opponentHandCount, 'observation.publicState.opponentHandCount');
  nonNegativeInteger(privateState.deckCount, 'observation.privateState.deckCount');
  return value as PtcgEnvironmentObservation;
}

export function roundTripPtcgEnvironmentObservation(
  observation: PtcgEnvironmentObservation
): PtcgEnvironmentObservation {
  return validatePtcgEnvironmentObservation(JSON.parse(JSON.stringify(observation)));
}

export interface PtcgAgentRequest {
  matchId: string;
  seed: number;
  seat: Seat;
  deckId: string;
  opponentSubmissionId: string;
}

export interface PtcgAgentResponse {
  score: number;
  latencyMs: number;
  fallback: boolean;
  fault?: Omit<MatchFault, 'seat'>;
}

/** Stable boundary implemented by 松・竹・梅・zero. */
export interface PtcgAgentAdapter {
  readonly apiVersion: 'ptcg-agent-adapter/v1';
  readonly id: PtcgAgentId;
  readonly displayName: '松' | '竹' | '梅' | 'Zero';
  readonly implementationVersion: string;
  initialize(config: PtcgAgentCoreConfig): Promise<void>;
  invoke(request: PtcgAgentRequest): Promise<PtcgAgentResponse>;
  close(): Promise<void>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`${label} has unknown fields: ${unexpected.join(', ')}`);
}

function agentId(value: unknown): PtcgAgentId {
  if (!['matsu', 'take', 'ume', 'zero'].includes(String(value))) {
    throw new Error('agent.id must be one of matsu, take, ume, zero');
  }
  return value as PtcgAgentId;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${label} must be non-empty`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

export function migratePtcgAgentConfig(value: unknown): PtcgAgentCoreConfig {
  const root = record(value, 'config');
  if (root.schemaVersion === PTCG_AGENT_CONFIG_VERSION) return validatePtcgAgentConfig(root);
  if (root.schemaVersion !== 'ptcg-agent-core/v1') {
    throw new Error(`unsupported config schemaVersion: ${String(root.schemaVersion)}`);
  }
  exactKeys(root, ['schemaVersion', 'agentId', 'entrypoint', 'seed', 'timeoutMs'], 'config v1');
  return validatePtcgAgentConfig({
    schemaVersion: PTCG_AGENT_CONFIG_VERSION,
    agent: { id: agentId(root.agentId), entrypoint: nonEmpty(root.entrypoint, 'entrypoint') },
    runtime: {
      seed: root.seed ?? PTCG_AGENT_CONFIG_DEFAULTS.seed,
      timeoutMs: root.timeoutMs ?? PTCG_AGENT_CONFIG_DEFAULTS.timeoutMs,
      maxRetries: PTCG_AGENT_CONFIG_DEFAULTS.maxRetries,
    },
    compatibility: { adapterApi: 'ptcg-agent-adapter/v1' },
  });
}

export function validatePtcgAgentConfig(value: unknown): PtcgAgentCoreConfig {
  const root = record(value, 'config');
  exactKeys(root, ['schemaVersion', 'agent', 'runtime', 'compatibility'], 'config');
  if (root.schemaVersion !== PTCG_AGENT_CONFIG_VERSION) {
    throw new Error(`schemaVersion must be ${PTCG_AGENT_CONFIG_VERSION}`);
  }
  const agent = record(root.agent, 'agent');
  exactKeys(agent, ['id', 'entrypoint'], 'agent');
  const runtime = record(root.runtime, 'runtime');
  exactKeys(runtime, ['seed', 'timeoutMs', 'maxRetries'], 'runtime');
  const compatibility = record(root.compatibility, 'compatibility');
  exactKeys(compatibility, ['adapterApi'], 'compatibility');
  if (compatibility.adapterApi !== 'ptcg-agent-adapter/v1') {
    throw new Error('compatibility.adapterApi must be ptcg-agent-adapter/v1');
  }
  const timeoutMs = nonNegativeInteger(runtime.timeoutMs, 'runtime.timeoutMs');
  if (timeoutMs === 0) throw new Error('runtime.timeoutMs must be greater than zero');
  return {
    schemaVersion: PTCG_AGENT_CONFIG_VERSION,
    agent: { id: agentId(agent.id), entrypoint: nonEmpty(agent.entrypoint, 'agent.entrypoint') },
    runtime: {
      seed: nonNegativeInteger(runtime.seed, 'runtime.seed'),
      timeoutMs,
      maxRetries: nonNegativeInteger(runtime.maxRetries, 'runtime.maxRetries'),
    },
    compatibility: { adapterApi: 'ptcg-agent-adapter/v1' },
  };
}

export function parsePtcgAgentConfig(json: string): PtcgAgentCoreConfig {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(`config is not valid JSON: ${(error as Error).message}`);
  }
  return migratePtcgAgentConfig(value);
}

export function encodePtcgAgentConfig(config: PtcgAgentCoreConfig): string {
  return `${JSON.stringify(validatePtcgAgentConfig(config))}\n`;
}
