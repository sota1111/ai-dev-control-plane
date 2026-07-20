import type { PtcgEnvironmentAction, PtcgEnvironmentObservation } from './ptcgAgentCore.js';

export const PTCG_REWARD_API_VERSION = 'ptcg-reward/v1' as const;
export const PTCG_REWARD_EVALUATION_SCHEMA_VERSION = 'ptcg-reward-evaluation/v1' as const;

export type PtcgRewardComponentId = 'prize-progress' | 'terminal-outcome' | 'turn-cost';

/** Environment-only input. It deliberately contains no learner, model, or search state. */
export interface PtcgRewardTransition {
  before: PtcgEnvironmentObservation;
  action: PtcgEnvironmentAction;
  after: PtcgEnvironmentObservation;
  terminal: boolean;
  winner?: PtcgEnvironmentObservation['seat'];
}

export interface PtcgRewardComponentConfig {
  id: PtcgRewardComponentId;
  weight: number;
  parameters?: Readonly<Record<string, number>>;
}

export interface PtcgRewardConfig {
  schemaVersion: 'ptcg-reward-config/v1';
  components: readonly PtcgRewardComponentConfig[];
}

export interface PtcgRewardContribution {
  id: PtcgRewardComponentId;
  raw: number;
  weight: number;
  weighted: number;
}

/** Shared serializable result schema for training, inference, and offline evaluation. */
export interface PtcgRewardEvaluation {
  schemaVersion: typeof PTCG_REWARD_EVALUATION_SCHEMA_VERSION;
  total: number;
  contributions: PtcgRewardContribution[];
}

export interface PtcgRewardComponent {
  readonly apiVersion: typeof PTCG_REWARD_API_VERSION;
  readonly id: PtcgRewardComponentId;
  evaluate(transition: PtcgRewardTransition, parameters: Readonly<Record<string, number>>): number;
}

export type PtcgRewardComponentFactory = () => PtcgRewardComponent;

export class PtcgRewardRegistry {
  private readonly factories = new Map<PtcgRewardComponentId, PtcgRewardComponentFactory>();

  register(id: PtcgRewardComponentId, factory: PtcgRewardComponentFactory): this {
    if (this.factories.has(id)) throw new Error(`reward component already registered: ${id}`);
    this.factories.set(id, factory);
    return this;
  }

  create(id: PtcgRewardComponentId): PtcgRewardComponent {
    const component = this.factories.get(id)?.();
    if (!component) throw new Error(`unknown reward component: ${id}`);
    if (component.apiVersion !== PTCG_REWARD_API_VERSION || component.id !== id) {
      throw new Error(`invalid reward component registration: ${id}`);
    }
    return component;
  }
}

class PrizeProgressReward implements PtcgRewardComponent {
  readonly apiVersion = PTCG_REWARD_API_VERSION;
  readonly id = 'prize-progress' as const;

  evaluate(transition: PtcgRewardTransition): number {
    const seat = transition.before.seat;
    return (
      transition.before.publicState.prizeCount[seat] - transition.after.publicState.prizeCount[seat]
    );
  }
}

class TerminalOutcomeReward implements PtcgRewardComponent {
  readonly apiVersion = PTCG_REWARD_API_VERSION;
  readonly id = 'terminal-outcome' as const;

  evaluate(transition: PtcgRewardTransition, parameters: Readonly<Record<string, number>>): number {
    if (!transition.terminal) return 0;
    if (!transition.winner) throw new Error('terminal reward requires winner');
    return transition.winner === transition.before.seat
      ? (parameters.win ?? 1)
      : (parameters.loss ?? -1);
  }
}

class TurnCostReward implements PtcgRewardComponent {
  readonly apiVersion = PTCG_REWARD_API_VERSION;
  readonly id = 'turn-cost' as const;

  evaluate(
    _transition: PtcgRewardTransition,
    parameters: Readonly<Record<string, number>>
  ): number {
    return parameters.cost ?? -1;
  }
}

export function createDefaultPtcgRewardRegistry(): PtcgRewardRegistry {
  return new PtcgRewardRegistry()
    .register('prize-progress', () => new PrizeProgressReward())
    .register('terminal-outcome', () => new TerminalOutcomeReward())
    .register('turn-cost', () => new TurnCostReward());
}

export function validatePtcgRewardConfig(value: PtcgRewardConfig): PtcgRewardConfig {
  if (value.schemaVersion !== 'ptcg-reward-config/v1') {
    throw new Error('reward config schemaVersion must be ptcg-reward-config/v1');
  }
  if (!Array.isArray(value.components) || value.components.length === 0) {
    throw new Error('reward config requires at least one component');
  }
  const ids = new Set<PtcgRewardComponentId>();
  for (const component of value.components) {
    if (ids.has(component.id)) throw new Error(`duplicate reward component: ${component.id}`);
    ids.add(component.id);
    if (!Number.isFinite(component.weight))
      throw new Error(`${component.id} weight must be finite`);
    for (const [name, parameter] of Object.entries(component.parameters ?? {})) {
      if (!Number.isFinite(parameter)) throw new Error(`${component.id}.${name} must be finite`);
    }
  }
  return value;
}

export class ComposedPtcgReward {
  readonly apiVersion = PTCG_REWARD_API_VERSION;

  constructor(
    readonly config: PtcgRewardConfig,
    private readonly registry: PtcgRewardRegistry = createDefaultPtcgRewardRegistry()
  ) {
    validatePtcgRewardConfig(config);
  }

  evaluate(transition: PtcgRewardTransition): PtcgRewardEvaluation {
    const contributions = this.config.components.map(({ id, weight, parameters = {} }) => {
      const raw = this.registry.create(id).evaluate(transition, parameters);
      if (!Number.isFinite(raw))
        throw new Error(`reward component returned non-finite value: ${id}`);
      return { id, raw, weight, weighted: raw * weight };
    });
    return {
      schemaVersion: PTCG_REWARD_EVALUATION_SCHEMA_VERSION,
      total: contributions.reduce((sum, component) => sum + component.weighted, 0),
      contributions,
    };
  }
}

export interface PtcgRewardFixture {
  id: string;
  transition: PtcgRewardTransition;
}

export function comparePtcgRewardConfigs(
  fixture: PtcgRewardFixture,
  configs: Readonly<Record<string, PtcgRewardConfig>>,
  registry = createDefaultPtcgRewardRegistry()
): Record<string, PtcgRewardEvaluation> {
  return Object.fromEntries(
    Object.entries(configs).map(([name, config]) => [
      name,
      new ComposedPtcgReward(config, registry).evaluate(fixture.transition),
    ])
  );
}
