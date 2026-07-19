import fs from 'node:fs';

export const LEAGUE_REGISTRY_SCHEMA = 'ptcg-league-registry/v1' as const;
export const LEAGUE_MATCH_SCHEMA = 'ptcg-league-match/v1' as const;

export interface AgentRegistration {
  id: string;
  name: string;
  version: string;
}

export interface DeckRegistration {
  id: string;
  name: string;
  contentHash: string;
  version: string;
}

export interface SubmissionRegistration {
  id: string;
  agentId: string;
  deckId: string;
  version: string;
}

export interface LeagueRegistry {
  schemaVersion: typeof LEAGUE_REGISTRY_SCHEMA;
  agents: AgentRegistration[];
  decks: DeckRegistration[];
  submissions: SubmissionRegistration[];
}

export type Seat = 'first' | 'second';
export type MatchOutcome = Seat | 'draw' | 'no-contest';

export interface MatchFault {
  seat: Seat;
  kind: 'illegal-action' | 'timeout' | 'crash' | 'adapter' | 'engine' | 'other';
  code: string;
}

export interface LeagueMatchRecord {
  schemaVersion: typeof LEAGUE_MATCH_SCHEMA;
  matchId: string;
  seed: number;
  seats: {
    first: { submissionId: string };
    second: { submissionId: string };
  };
  result: {
    outcome: MatchOutcome;
    fault: MatchFault | null;
  };
  latencyMs: {
    first: number;
    second: number;
    total: number;
  };
  versions: {
    registry: string;
    engine: string;
    adapter: string;
  };
}

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function validateRegistry(value: unknown): string[] {
  const errors: string[] = [];
  const root = object(value);
  if (!root) return ['registry must be an object'];
  if (root.schemaVersion !== LEAGUE_REGISTRY_SCHEMA)
    errors.push(`schemaVersion must be ${LEAGUE_REGISTRY_SCHEMA}`);
  const collections = ['agents', 'decks', 'submissions'] as const;
  for (const key of collections)
    if (!Array.isArray(root[key])) errors.push(`${key} must be an array`);
  if (errors.length) return errors;

  const agents = root.agents as unknown[];
  const decks = root.decks as unknown[];
  const submissions = root.submissions as unknown[];
  const allIds = new Set<string>();
  const agentIds = new Set<string>();
  const deckIds = new Set<string>();
  const registerId = (id: unknown, path: string, own: Set<string>): void => {
    if (!validId(id)) {
      errors.push(`${path}.id must be a stable lowercase id`);
      return;
    }
    if (allIds.has(id)) errors.push(`${path}.id duplicates registry id ${id}`);
    allIds.add(id);
    own.add(id);
  };
  agents.forEach((entry, i) => {
    const row = object(entry);
    if (!row) return errors.push(`agents[${i}] must be an object`);
    registerId(row.id, `agents[${i}]`, agentIds);
    if (!nonEmpty(row.name)) errors.push(`agents[${i}].name must be non-empty`);
    if (!nonEmpty(row.version)) errors.push(`agents[${i}].version must be non-empty`);
  });
  decks.forEach((entry, i) => {
    const row = object(entry);
    if (!row) return errors.push(`decks[${i}] must be an object`);
    registerId(row.id, `decks[${i}]`, deckIds);
    if (!nonEmpty(row.name)) errors.push(`decks[${i}].name must be non-empty`);
    if (typeof row.contentHash !== 'string' || !HASH_RE.test(row.contentHash))
      errors.push(`decks[${i}].contentHash must be sha256:<64 lowercase hex>`);
    if (!nonEmpty(row.version)) errors.push(`decks[${i}].version must be non-empty`);
  });
  submissions.forEach((entry, i) => {
    const row = object(entry);
    if (!row) return errors.push(`submissions[${i}] must be an object`);
    registerId(row.id, `submissions[${i}]`, new Set());
    if (!validId(row.agentId) || !agentIds.has(row.agentId))
      errors.push(`submissions[${i}].agentId must reference an agent`);
    if (!validId(row.deckId) || !deckIds.has(row.deckId))
      errors.push(`submissions[${i}].deckId must reference a deck`);
    if (!nonEmpty(row.version)) errors.push(`submissions[${i}].version must be non-empty`);
  });
  return errors;
}

export function validateMatchRecord(value: unknown, registry?: LeagueRegistry): string[] {
  const errors: string[] = [];
  const root = object(value);
  if (!root) return ['match record must be an object'];
  if (root.schemaVersion !== LEAGUE_MATCH_SCHEMA)
    errors.push(`schemaVersion must be ${LEAGUE_MATCH_SCHEMA}`);
  if (!validId(root.matchId)) errors.push('matchId must be a stable lowercase id');
  if (!Number.isSafeInteger(root.seed) || (root.seed as number) < 0)
    errors.push('seed must be a non-negative safe integer');
  const seats = object(root.seats);
  const first = object(seats?.first);
  const second = object(seats?.second);
  if (!validId(first?.submissionId)) errors.push('seats.first.submissionId must be a stable id');
  if (!validId(second?.submissionId)) errors.push('seats.second.submissionId must be a stable id');
  if (first?.submissionId === second?.submissionId)
    errors.push('first and second submissions must differ');
  if (registry) {
    const ids = new Set(registry.submissions.map((s) => s.id));
    if (validId(first?.submissionId) && !ids.has(first.submissionId))
      errors.push('seats.first.submissionId is not registered');
    if (validId(second?.submissionId) && !ids.has(second.submissionId))
      errors.push('seats.second.submissionId is not registered');
  }
  const result = object(root.result);
  if (!['first', 'second', 'draw', 'no-contest'].includes(String(result?.outcome)))
    errors.push('result.outcome must be first, second, draw, or no-contest');
  if (result?.fault !== null) {
    const fault = object(result?.fault);
    if (!fault) errors.push('result.fault must be null or an object');
    else {
      if (!['first', 'second'].includes(String(fault.seat)))
        errors.push('result.fault.seat must be first or second');
      if (
        !['illegal-action', 'timeout', 'crash', 'adapter', 'engine', 'other'].includes(
          String(fault.kind)
        )
      )
        errors.push('result.fault.kind is invalid');
      if (!nonEmpty(fault.code)) errors.push('result.fault.code must be non-empty');
    }
  }
  const latency = object(root.latencyMs);
  for (const key of ['first', 'second', 'total'] as const)
    if (!finiteNonNegative(latency?.[key]))
      errors.push(`latencyMs.${key} must be finite and non-negative`);
  if (
    finiteNonNegative(latency?.first) &&
    finiteNonNegative(latency?.second) &&
    finiteNonNegative(latency?.total) &&
    latency.total < latency.first + latency.second
  )
    errors.push('latencyMs.total must be at least first + second');
  const versions = object(root.versions);
  for (const key of ['registry', 'engine', 'adapter'] as const)
    if (!nonEmpty(versions?.[key])) errors.push(`versions.${key} must be non-empty`);
  return errors;
}

export function encodeMatchRecord(record: LeagueMatchRecord): string {
  const errors = validateMatchRecord(record);
  if (errors.length) throw new Error(errors.join('; '));
  return `${JSON.stringify(record)}\n`;
}

export function parseMatchJsonl(text: string, registry?: LeagueRegistry): LeagueMatchRecord[] {
  const records: LeagueMatchRecord[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`line ${index + 1}: invalid JSON`);
    }
    const errors = validateMatchRecord(value, registry);
    if (errors.length) throw new Error(`line ${index + 1}: ${errors.join('; ')}`);
    records.push(value as LeagueMatchRecord);
  }
  return records;
}

export function readMatchJsonl(file: string, registry?: LeagueRegistry): LeagueMatchRecord[] {
  return parseMatchJsonl(fs.readFileSync(file, 'utf8'), registry);
}
