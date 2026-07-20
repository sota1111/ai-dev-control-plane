import type { PtcgEnvironmentAction, PtcgEnvironmentObservation } from './ptcgAgentCore.js';

export const PTCG_SEARCH_API_VERSION = 'ptcg-search/v1' as const;

export type PtcgSearchBackendId = 'mcts' | 'alphazero' | 'rule-based' | 'hybrid';

export interface PtcgSearchOptions {
  seed: number;
  simulations?: number;
}

export interface PtcgSearchResult {
  backend: PtcgSearchBackendId;
  actionId: string;
  scores: Record<string, number>;
  seed: number;
  simulations: number;
}

/** Algorithm-independent contract shared by every PTCG action-search backend. */
export interface PtcgSearch {
  readonly apiVersion: typeof PTCG_SEARCH_API_VERSION;
  readonly id: PtcgSearchBackendId;
  search(observation: PtcgEnvironmentObservation, options: PtcgSearchOptions): PtcgSearchResult;
}

export type PtcgSearchFactory = () => PtcgSearch;

function legalActions(observation: PtcgEnvironmentObservation): PtcgEnvironmentAction[] {
  const legal = observation.actionSpace.filter((action) =>
    observation.legalActionIds.includes(action.id)
  );
  if (legal.length === 0) throw new Error('search requires at least one legal action');
  return legal;
}

function actionValue(action: PtcgEnvironmentAction): number {
  if (action.kind === 'attack') return 3;
  if (action.kind === 'play-card') return 2;
  return 1;
}

function seededUnit(seed: number, actionId: string, simulation: number): number {
  let state = (seed ^ simulation) >>> 0;
  for (const character of actionId) state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 0x1_0000_0000;
}

function choose(
  backend: PtcgSearchBackendId,
  scores: Record<string, number>,
  options: PtcgSearchOptions,
  simulations: number
): PtcgSearchResult {
  const actionId = Object.entries(scores).sort(
    ([leftId, left], [rightId, right]) => right - left || leftId.localeCompare(rightId)
  )[0]?.[0];
  if (!actionId) throw new Error('search produced no action scores');
  return { backend, actionId, scores, seed: options.seed, simulations };
}

class RuleBasedSearch implements PtcgSearch {
  readonly apiVersion = PTCG_SEARCH_API_VERSION;
  readonly id = 'rule-based' as const;

  search(observation: PtcgEnvironmentObservation, options: PtcgSearchOptions): PtcgSearchResult {
    const scores = Object.fromEntries(
      legalActions(observation).map((action) => [action.id, actionValue(action)])
    );
    return choose(this.id, scores, options, options.simulations ?? 0);
  }
}

class AlphaZeroSearch implements PtcgSearch {
  readonly apiVersion = PTCG_SEARCH_API_VERSION;
  readonly id = 'alphazero' as const;

  search(observation: PtcgEnvironmentObservation, options: PtcgSearchOptions): PtcgSearchResult {
    const simulations = options.simulations ?? 64;
    const scores = Object.fromEntries(
      legalActions(observation).map((action) => {
        const policyPrior = actionValue(action) / 3;
        const value = policyPrior + seededUnit(options.seed, action.id, simulations) * 0.05;
        return [action.id, value];
      })
    );
    return choose(this.id, scores, options, simulations);
  }
}

class MctsSearch implements PtcgSearch {
  readonly apiVersion = PTCG_SEARCH_API_VERSION;
  readonly id = 'mcts' as const;

  search(observation: PtcgEnvironmentObservation, options: PtcgSearchOptions): PtcgSearchResult {
    const simulations = options.simulations ?? 64;
    if (!Number.isSafeInteger(simulations) || simulations <= 0) {
      throw new Error('simulations must be a positive safe integer');
    }
    const scores = Object.fromEntries(
      legalActions(observation).map((action) => {
        let total = 0;
        for (let simulation = 0; simulation < simulations; simulation += 1) {
          total += actionValue(action) + seededUnit(options.seed, action.id, simulation) - 0.5;
        }
        return [action.id, total / simulations];
      })
    );
    return choose(this.id, scores, options, simulations);
  }
}

class HybridSearch implements PtcgSearch {
  readonly apiVersion = PTCG_SEARCH_API_VERSION;
  readonly id = 'hybrid' as const;

  search(observation: PtcgEnvironmentObservation, options: PtcgSearchOptions): PtcgSearchResult {
    const mcts = new MctsSearch().search(observation, options);
    const rules = new RuleBasedSearch().search(observation, options);
    const scores = Object.fromEntries(
      Object.keys(mcts.scores).map((actionId) => [
        actionId,
        mcts.scores[actionId] * 0.7 + rules.scores[actionId] * 0.3,
      ])
    );
    return choose(this.id, scores, options, mcts.simulations);
  }
}

export class PtcgSearchRegistry {
  private readonly factories = new Map<PtcgSearchBackendId, PtcgSearchFactory>();

  register(id: PtcgSearchBackendId, factory: PtcgSearchFactory): this {
    if (this.factories.has(id)) throw new Error(`search backend already registered: ${id}`);
    this.factories.set(id, factory);
    return this;
  }

  create(id: PtcgSearchBackendId): PtcgSearch {
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`unknown search backend: ${id}`);
    const backend = factory();
    if (backend.apiVersion !== PTCG_SEARCH_API_VERSION || backend.id !== id) {
      throw new Error(`invalid search backend registration: ${id}`);
    }
    return backend;
  }

  ids(): PtcgSearchBackendId[] {
    return [...this.factories.keys()];
  }
}

export function createDefaultPtcgSearchRegistry(): PtcgSearchRegistry {
  return new PtcgSearchRegistry()
    .register('mcts', () => new MctsSearch())
    .register('alphazero', () => new AlphaZeroSearch())
    .register('rule-based', () => new RuleBasedSearch())
    .register('hybrid', () => new HybridSearch());
}

export function comparePtcgSearchBackends(
  observation: PtcgEnvironmentObservation,
  options: PtcgSearchOptions,
  backendIds: readonly PtcgSearchBackendId[] = createDefaultPtcgSearchRegistry().ids()
): PtcgSearchResult[] {
  const registry = createDefaultPtcgSearchRegistry();
  return backendIds.map((id) => registry.create(id).search(observation, options));
}
