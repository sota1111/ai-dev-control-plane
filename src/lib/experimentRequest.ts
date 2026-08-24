/**
 * Versioned ingress contract emitted by epistemic-research-loop.
 *
 * ai-dev-control-plane does not decide what experiment to run. It validates the contract at the
 * signed Linear webhook boundary, then queues the Linear issue through the normal execution path.
 */

export const EXPERIMENT_REQUEST_MARKER = '<!-- epistemic-research-loop:experiment-request:v1 -->';

export interface ExperimentRequestContract {
  request_id: string;
  experiment_id: string;
  run_id: string;
  idempotency_key: string;
  base_commit_sha: string;
  implementation_mode: string;
  objective: string;
  command: string;
  container_image: string;
  dataset_mounts: Array<{ name: string; read_only: boolean }>;
  resources: {
    cpu: number;
    memory_gb: number;
    gpu: number;
    timeout_seconds: number;
  };
  seeds: number[];
  required_outputs: string[];
  network_policy: 'disabled' | 'source_policy_proxy' | 'enabled';
}

export type ParsedExperimentRequest =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'valid'; request: ExperimentRequestContract };

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function invalid(reason: string): ParsedExperimentRequest {
  return { kind: 'invalid', reason };
}

export function parseExperimentRequest(description: unknown): ParsedExperimentRequest {
  if (typeof description !== 'string' || !description.includes(EXPERIMENT_REQUEST_MARKER)) {
    return { kind: 'none' };
  }
  if (description.length > 256 * 1024) {
    return invalid('experiment request description exceeds 256 KiB');
  }
  const block = description.match(/```json\s*([\s\S]*?)```/i);
  if (!block) return invalid('versioned marker requires a JSON code block');

  let value: any;
  try {
    value = JSON.parse(block[1]);
  } catch (error: any) {
    return invalid(`experiment request JSON is invalid: ${error?.message || error}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('experiment request must be an object');
  }

  const requiredStrings = [
    'request_id',
    'experiment_id',
    'run_id',
    'idempotency_key',
    'base_commit_sha',
    'implementation_mode',
    'objective',
    'command',
    'container_image',
  ] as const;
  for (const field of requiredStrings) {
    if (!nonEmpty(value[field])) return invalid(`${field} must be a non-empty string`);
  }
  if (!/^.+:.+:attempt-[1-9]\d*$/.test(value.idempotency_key)) {
    return invalid('idempotency_key must end with :attempt-N');
  }
  if (!value.idempotency_key.startsWith(`${value.run_id}:${value.experiment_id}:`)) {
    return invalid('idempotency_key must be scoped to run_id and experiment_id');
  }
  if (
    !Array.isArray(value.seeds) ||
    value.seeds.length === 0 ||
    value.seeds.some((seed: unknown) => !Number.isSafeInteger(seed))
  ) {
    return invalid('seeds must be a non-empty integer array');
  }
  if (new Set(value.seeds).size !== value.seeds.length) {
    return invalid('seeds must be unique');
  }
  if (
    !Array.isArray(value.required_outputs) ||
    value.required_outputs.length === 0 ||
    value.required_outputs.some((output: unknown) => !nonEmpty(output))
  ) {
    return invalid('required_outputs must be a non-empty string array');
  }
  if (
    value.required_outputs.some((output: string) => output.startsWith('/') || output.includes('..'))
  ) {
    return invalid('required_outputs must be safe relative paths');
  }
  if (
    !Array.isArray(value.dataset_mounts) ||
    value.dataset_mounts.some(
      (mount: any) => !mount || !nonEmpty(mount.name) || mount.read_only !== true
    )
  ) {
    return invalid('dataset_mounts must be read-only named mounts');
  }
  const resources = value.resources;
  if (
    !resources ||
    !Number.isSafeInteger(resources.cpu) ||
    resources.cpu < 1 ||
    !finiteNonNegative(resources.memory_gb) ||
    resources.memory_gb === 0 ||
    !Number.isSafeInteger(resources.gpu) ||
    resources.gpu < 0 ||
    !Number.isSafeInteger(resources.timeout_seconds) ||
    resources.timeout_seconds < 1
  ) {
    return invalid('resources are invalid');
  }
  if (!['disabled', 'source_policy_proxy', 'enabled'].includes(value.network_policy)) {
    return invalid('network_policy is invalid');
  }

  return { kind: 'valid', request: value as ExperimentRequestContract };
}
