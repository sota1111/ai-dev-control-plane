export type ExecutionMode = 'solo' | 'graph';
export type ExecutionPlanSource = 'issue' | 'environment' | 'worker-config' | 'default';

export interface ExecutionPlanInput {
  graphDirective?: string;
  namedGraphPath?: string;
  namedGraphError?: string;
  pipelineGraphEnabled?: boolean;
  defaultGraphPath: string;
  configuredGraphPath?: string;
  soloWorker?: string | null;
}

export interface ExecutionPlan {
  mode: ExecutionMode;
  graphPath?: string;
  soloWorker?: string;
  source: ExecutionPlanSource;
  reason: string;
  overrides: string[];
  warnings: string[];
}

/**
 * Resolve the pipeline mode in one place. The precedence intentionally preserves the SOT-1755
 * behavior: a valid, explicitly named issue graph overrides repository solo mode. An invalid named
 * graph fails open to the normal solo/environment/default decision.
 */
export function resolveExecutionPlan(input: ExecutionPlanInput): ExecutionPlan {
  const overrides: string[] = [];
  const warnings: string[] = [];
  const directive = input.graphDirective?.trim();

  if (directive && directive !== 'default') {
    if (input.namedGraphPath) {
      if (input.soloWorker) overrides.push(`worker-config solo=${input.soloWorker}`);
      if (input.pipelineGraphEnabled) overrides.push('PIPELINE_GRAPH');
      if (input.configuredGraphPath) overrides.push(`PIPELINE_GRAPH_FILE=${input.configuredGraphPath}`);
      return {
        mode: 'graph',
        graphPath: input.namedGraphPath,
        source: 'issue',
        reason: `issue selected graph "${directive}"`,
        overrides,
        warnings,
      };
    }
    warnings.push(input.namedGraphError ?? `unknown or invalid graph "${directive}"`);
  }

  if (input.soloWorker) {
    if (input.pipelineGraphEnabled) overrides.push('PIPELINE_GRAPH');
    if (input.configuredGraphPath) overrides.push(`PIPELINE_GRAPH_FILE=${input.configuredGraphPath}`);
    return {
      mode: 'solo',
      soloWorker: input.soloWorker,
      source: 'worker-config',
      reason: `worker config selected solo worker "${input.soloWorker}"`,
      overrides,
      warnings,
    };
  }

  return {
    mode: 'graph',
    graphPath: input.configuredGraphPath || input.defaultGraphPath,
    source: input.configuredGraphPath || input.pipelineGraphEnabled ? 'environment' : 'default',
    reason: input.configuredGraphPath
      ? 'PIPELINE_GRAPH_FILE selected the configured graph'
      : 'the default pipeline graph is the unified execution model',
    overrides,
    warnings,
  };
}

export function isTruthyFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

export function explainExecutionPlan(plan: ExecutionPlan): string {
  const lines = [
    `mode: ${plan.mode}`,
    `source: ${plan.source}`,
    `reason: ${plan.reason}`,
  ];
  if (plan.graphPath) lines.push(`graph: ${plan.graphPath}`);
  if (plan.soloWorker) lines.push(`solo worker: ${plan.soloWorker}`);
  lines.push(`overrides: ${plan.overrides.length ? plan.overrides.join(', ') : 'none'}`);
  lines.push(`warnings: ${plan.warnings.length ? plan.warnings.join('; ') : 'none'}`);
  return `${lines.join('\n')}\n`;
}
