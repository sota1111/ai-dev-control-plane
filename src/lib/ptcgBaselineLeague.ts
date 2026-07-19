import fs from 'node:fs';
import path from 'node:path';
import {
  LEAGUE_MATCH_SCHEMA,
  LEAGUE_REGISTRY_SCHEMA,
  validateMatchRecord,
  validateRegistry,
  type DeckRegistration,
  type LeagueMatchRecord,
  type LeagueRegistry,
  type MatchFault,
  type MatchOutcome,
  type Seat,
} from './ptcgLeagueContract.js';
import { wilson95, writeFileAtomic } from './ptcgBattleLab.js';

export const BASELINE_SCHEMA = 'ptcg-baseline/v1' as const;
export const CURRENT_ADAPTER_VERSION = 'current-adapter/v1';

export interface AgentRequest {
  matchId: string;
  seed: number;
  seat: Seat;
  deckId: string;
  opponentSubmissionId: string;
}

export interface AgentResponse {
  score: number;
  latencyMs: number;
  fallback: boolean;
  fault?: Omit<MatchFault, 'seat'>;
}

/** Common launch boundary implemented by 松・竹・梅・Zero adapters. */
export interface AgentAdapter {
  id: 'matsu' | 'take' | 'ume' | 'zero';
  name: '松' | '竹' | '梅' | 'Zero';
  version: string;
  entrypoint: string;
  invoke(request: AgentRequest): Promise<AgentResponse>;
}

export interface BaselineConfig {
  runId: string;
  generatedAt: string;
  seeds: number[];
  engineVersion: string;
  registryVersion: string;
}

export interface PayoffCell {
  rowSubmissionId: string;
  columnSubmissionId: string;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  ciLow: number;
  ciHigh: number;
}

export interface BaselineArtifact {
  schemaVersion: typeof BASELINE_SCHEMA;
  config: BaselineConfig;
  registry: LeagueRegistry;
  matches: LeagueMatchRecord[];
  payoff: PayoffCell[];
  kpi: {
    matches: number;
    faults: number;
    fallbacks: number;
    latencyMs: { average: number; max: number };
  };
}

export function currentAgentAdapters(
  invoke: (agentId: AgentAdapter['id'], request: AgentRequest) => Promise<AgentResponse>
): AgentAdapter[] {
  const definitions = [
    ['matsu', '松', 'ptcg-agent-matsu:main.agent'],
    ['take', '竹', 'ptcg-agent-take:main.agent'],
    ['ume', '梅', 'ptcg-agent-ume:main.agent'],
    ['zero', 'Zero', 'ptcg-agent-zero:ptcg_agent_zero.submission.agent'],
  ] as const;
  return definitions.map(([id, name, entrypoint]) => ({
    id,
    name,
    entrypoint,
    version: CURRENT_ADAPTER_VERSION,
    invoke: (request) => invoke(id, request),
  }));
}

function submissionId(agentId: string, deckId: string): string {
  return `submission.${agentId}.${deckId.replace(/^deck\./, '')}`;
}

export function buildBaselineRegistry(
  adapters: AgentAdapter[],
  decks: DeckRegistration[]
): LeagueRegistry {
  const registry: LeagueRegistry = {
    schemaVersion: LEAGUE_REGISTRY_SCHEMA,
    agents: adapters.map((a) => ({ id: `agent.${a.id}`, name: a.name, version: a.version })),
    decks,
    submissions: adapters.flatMap((a) =>
      decks.map((deck) => ({
        id: submissionId(a.id, deck.id),
        agentId: `agent.${a.id}`,
        deckId: deck.id,
        version: a.version,
      }))
    ),
  };
  const errors = validateRegistry(registry);
  if (errors.length) throw new Error(`invalid baseline registry: ${errors.join('; ')}`);
  return registry;
}

function faultOutcome(first: AgentResponse, second: AgentResponse): MatchOutcome {
  if (first.fault && second.fault) return 'no-contest';
  if (first.fault) return 'second';
  if (second.fault) return 'first';
  if (first.score === second.score) return 'draw';
  return first.score > second.score ? 'first' : 'second';
}

function firstFault(first: AgentResponse, second: AgentResponse): MatchFault | null {
  if (first.fault) return { seat: 'first', ...first.fault };
  if (second.fault) return { seat: 'second', ...second.fault };
  return null;
}

/** Run every agent×deck submission pair in both seat orientations for every seed. */
export async function runBaselineLeague(options: {
  adapters: AgentAdapter[];
  decks: DeckRegistration[];
  config: BaselineConfig;
}): Promise<BaselineArtifact> {
  if (new Set(options.adapters.map((a) => a.id)).size !== 4)
    throw new Error('baseline requires exactly the four current agent adapters');
  if (
    options.config.seeds.length === 0 ||
    options.config.seeds.some((s) => !Number.isSafeInteger(s) || s < 0)
  )
    throw new Error('baseline seeds must be non-empty non-negative safe integers');
  const registry = buildBaselineRegistry(options.adapters, options.decks);
  const adapterByAgent = new Map(options.adapters.map((a) => [`agent.${a.id}`, a]));
  const records: LeagueMatchRecord[] = [];
  let fallbacks = 0;
  for (let i = 0; i < registry.submissions.length; i++) {
    for (let j = i + 1; j < registry.submissions.length; j++) {
      const pair = [registry.submissions[i], registry.submissions[j]];
      for (const [first, second] of [pair, [...pair].reverse()] as const) {
        for (const seed of options.config.seeds) {
          const matchId = `match.${records.length.toString().padStart(6, '0')}`;
          const firstAdapter = adapterByAgent.get(first.agentId)!;
          const secondAdapter = adapterByAgent.get(second.agentId)!;
          const [firstResult, secondResult] = await Promise.all([
            firstAdapter.invoke({
              matchId,
              seed,
              seat: 'first',
              deckId: first.deckId,
              opponentSubmissionId: second.id,
            }),
            secondAdapter.invoke({
              matchId,
              seed,
              seat: 'second',
              deckId: second.deckId,
              opponentSubmissionId: first.id,
            }),
          ]);
          fallbacks += Number(firstResult.fallback) + Number(secondResult.fallback);
          const record: LeagueMatchRecord = {
            schemaVersion: LEAGUE_MATCH_SCHEMA,
            matchId,
            seed,
            seats: { first: { submissionId: first.id }, second: { submissionId: second.id } },
            result: {
              outcome: faultOutcome(firstResult, secondResult),
              fault: firstFault(firstResult, secondResult),
            },
            latencyMs: {
              first: firstResult.latencyMs,
              second: secondResult.latencyMs,
              total: firstResult.latencyMs + secondResult.latencyMs,
            },
            versions: {
              registry: options.config.registryVersion,
              engine: options.config.engineVersion,
              adapter: CURRENT_ADAPTER_VERSION,
            },
          };
          const errors = validateMatchRecord(record, registry);
          if (errors.length) throw new Error(`invalid baseline match: ${errors.join('; ')}`);
          records.push(record);
        }
      }
    }
  }
  const payoff = buildPayoffMatrix(registry, records);
  const latencies = records.map((m) => m.latencyMs.total);
  return {
    schemaVersion: BASELINE_SCHEMA,
    config: options.config,
    registry,
    matches: records,
    payoff,
    kpi: {
      matches: records.length,
      faults: records.filter((m) => m.result.fault !== null).length,
      fallbacks,
      latencyMs: {
        average: latencies.reduce((a, b) => a + b, 0) / latencies.length,
        max: Math.max(...latencies),
      },
    },
  };
}

export function buildPayoffMatrix(
  registry: LeagueRegistry,
  matches: LeagueMatchRecord[]
): PayoffCell[] {
  const cells: PayoffCell[] = [];
  for (const row of registry.submissions) {
    for (const column of registry.submissions) {
      if (row.id === column.id) continue;
      const relevant = matches.filter(
        (m) =>
          [m.seats.first.submissionId, m.seats.second.submissionId].includes(row.id) &&
          [m.seats.first.submissionId, m.seats.second.submissionId].includes(column.id)
      );
      let wins = 0;
      let losses = 0;
      let draws = 0;
      for (const match of relevant) {
        const rowSeat = match.seats.first.submissionId === row.id ? 'first' : 'second';
        if (match.result.outcome === rowSeat) wins++;
        else if (match.result.outcome === 'draw' || match.result.outcome === 'no-contest') draws++;
        else losses++;
      }
      const decided = wins + losses;
      const ci = wilson95(wins, decided);
      cells.push({
        rowSubmissionId: row.id,
        columnSubmissionId: column.id,
        matches: relevant.length,
        wins,
        losses,
        draws,
        winRate: decided === 0 ? 0 : wins / decided,
        ciLow: ci.low,
        ciHigh: ci.high,
      });
    }
  }
  return cells;
}

export function writeBaselineArtifact(file: string, artifact: BaselineArtifact): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(artifact, null, 2)}\n`);
}
