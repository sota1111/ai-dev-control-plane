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
