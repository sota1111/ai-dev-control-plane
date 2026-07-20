export const PTCG_NEURAL_API_VERSION = 'ptcg-neural/v1' as const;
export const PTCG_NEURAL_CONFIG_VERSION = 'ptcg-neural-config/v1' as const;

export type PtcgTensorDType = 'float32';

export interface PtcgTensor {
  dtype: PtcgTensorDType;
  shape: number[];
  data: number[];
}

export interface PtcgPolicyValueBatch {
  features: PtcgTensor;
  legalActionMask: PtcgTensor;
}

export interface PtcgPolicyValueOutput {
  policy: PtcgTensor;
  value: PtcgTensor;
}

export interface PtcgNeuralCapabilities {
  maxBatchSize: number;
  dtypes: readonly PtcgTensorDType[];
  transport: 'in-process' | 'ffi' | 'service';
  deterministic: boolean;
}

export interface PtcgNeuralBackendConfig {
  schemaVersion: typeof PTCG_NEURAL_CONFIG_VERSION;
  backend: string;
  featureSize: number;
  actionSize: number;
  maxBatchSize: number;
  transport: 'in-process' | 'ffi' | 'service';
  endpoint?: string;
}

export interface PtcgNeuralBackend {
  readonly apiVersion: typeof PTCG_NEURAL_API_VERSION;
  readonly id: string;
  readonly capabilities: PtcgNeuralCapabilities;
  infer(batch: PtcgPolicyValueBatch): Promise<PtcgPolicyValueOutput>;
  close(): Promise<void>;
}

/** JSON-safe request/response boundary implementable by an FFI bridge or network service. */
export interface PtcgNeuralTransport {
  invoke(request: {
    apiVersion: typeof PTCG_NEURAL_API_VERSION;
    backend: string;
    batch: PtcgPolicyValueBatch;
  }): Promise<PtcgPolicyValueOutput>;
  close?(): Promise<void>;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

export function validatePtcgNeuralConfig(value: unknown): PtcgNeuralBackendConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('neural config must be an object');
  }
  const config = value as Record<string, unknown>;
  const allowed = [
    'schemaVersion',
    'backend',
    'featureSize',
    'actionSize',
    'maxBatchSize',
    'transport',
    'endpoint',
  ];
  const unexpected = Object.keys(config).filter((key) => !allowed.includes(key));
  if (unexpected.length)
    throw new Error(`neural config has unknown fields: ${unexpected.join(', ')}`);
  if (config.schemaVersion !== PTCG_NEURAL_CONFIG_VERSION) {
    throw new Error(`neural config schemaVersion must be ${PTCG_NEURAL_CONFIG_VERSION}`);
  }
  if (typeof config.backend !== 'string' || config.backend.trim() === '') {
    throw new Error('neural config backend must be non-empty');
  }
  if (!['in-process', 'ffi', 'service'].includes(String(config.transport))) {
    throw new Error('neural config transport must be in-process, ffi, or service');
  }
  if (
    config.endpoint !== undefined &&
    (typeof config.endpoint !== 'string' || config.endpoint === '')
  ) {
    throw new Error('neural config endpoint must be non-empty when provided');
  }
  if (config.transport !== 'in-process' && config.endpoint === undefined) {
    throw new Error(`${String(config.transport)} neural config requires endpoint`);
  }
  return {
    schemaVersion: PTCG_NEURAL_CONFIG_VERSION,
    backend: config.backend,
    featureSize: positiveInteger(config.featureSize, 'neural config featureSize'),
    actionSize: positiveInteger(config.actionSize, 'neural config actionSize'),
    maxBatchSize: positiveInteger(config.maxBatchSize, 'neural config maxBatchSize'),
    transport: config.transport as PtcgNeuralBackendConfig['transport'],
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint as string }),
  };
}

function validateTensor(tensor: PtcgTensor, expectedShape: number[], label: string): void {
  if (tensor.dtype !== 'float32') throw new Error(`${label}.dtype must be float32`);
  if (
    tensor.shape.length !== expectedShape.length ||
    tensor.shape.some((n, i) => n !== expectedShape[i])
  ) {
    throw new Error(`${label}.shape must be [${expectedShape.join(', ')}]`);
  }
  const size = expectedShape.reduce((product, dimension) => product * dimension, 1);
  if (tensor.data.length !== size) throw new Error(`${label}.data length must be ${size}`);
  if (!tensor.data.every(Number.isFinite))
    throw new Error(`${label}.data must contain finite numbers`);
}

export function validatePtcgPolicyValueBatch(
  batch: PtcgPolicyValueBatch,
  config: Pick<PtcgNeuralBackendConfig, 'featureSize' | 'actionSize' | 'maxBatchSize'>
): number {
  const batchSize = positiveInteger(batch.features?.shape?.[0], 'batch size');
  if (batchSize > config.maxBatchSize)
    throw new Error(`batch size ${batchSize} exceeds maximum ${config.maxBatchSize}`);
  validateTensor(batch.features, [batchSize, config.featureSize], 'features');
  validateTensor(batch.legalActionMask, [batchSize, config.actionSize], 'legalActionMask');
  if (!batch.legalActionMask.data.every((value) => value === 0 || value === 1)) {
    throw new Error('legalActionMask.data must contain only 0 or 1');
  }
  for (let row = 0; row < batchSize; row += 1) {
    const start = row * config.actionSize;
    if (
      !batch.legalActionMask.data
        .slice(start, start + config.actionSize)
        .some((value) => value === 1)
    ) {
      throw new Error(`legalActionMask row ${row} has no legal action`);
    }
  }
  return batchSize;
}

export function validatePtcgPolicyValueOutput(
  output: PtcgPolicyValueOutput,
  batchSize: number,
  actionSize: number
): PtcgPolicyValueOutput {
  validateTensor(output.policy, [batchSize, actionSize], 'policy');
  validateTensor(output.value, [batchSize, 1], 'value');
  if (output.value.data.some((value) => value < -1 || value > 1)) {
    throw new Error('value.data must be within [-1, 1]');
  }
  return output;
}

abstract class CheckedBackend implements PtcgNeuralBackend {
  readonly apiVersion = PTCG_NEURAL_API_VERSION;
  abstract readonly id: string;
  abstract readonly capabilities: PtcgNeuralCapabilities;

  constructor(protected readonly config: PtcgNeuralBackendConfig) {}

  async infer(batch: PtcgPolicyValueBatch): Promise<PtcgPolicyValueOutput> {
    const batchSize = validatePtcgPolicyValueBatch(batch, this.config);
    return validatePtcgPolicyValueOutput(
      await this.inferChecked(batch),
      batchSize,
      this.config.actionSize
    );
  }

  protected abstract inferChecked(batch: PtcgPolicyValueBatch): Promise<PtcgPolicyValueOutput>;
  abstract close(): Promise<void>;
}

/** Small deterministic implementation used as the portable reference and fixture oracle. */
export class ReferencePtcgNeuralBackend extends CheckedBackend {
  readonly id: string;
  readonly capabilities: PtcgNeuralCapabilities;

  constructor(configValue: PtcgNeuralBackendConfig) {
    const config = validatePtcgNeuralConfig(configValue);
    if (config.transport !== 'in-process')
      throw new Error('reference backend requires in-process transport');
    super(config);
    this.id = config.backend;
    this.capabilities = {
      maxBatchSize: config.maxBatchSize,
      dtypes: ['float32'],
      transport: 'in-process',
      deterministic: true,
    };
  }

  protected async inferChecked(batch: PtcgPolicyValueBatch): Promise<PtcgPolicyValueOutput> {
    const batchSize = batch.features.shape[0];
    const policy: number[] = [];
    const value: number[] = [];
    for (let row = 0; row < batchSize; row += 1) {
      const features = batch.features.data.slice(
        row * this.config.featureSize,
        (row + 1) * this.config.featureSize
      );
      const mean = features.reduce((sum, feature) => sum + feature, 0) / features.length;
      value.push(Math.tanh(mean));
      const logits = Array.from({ length: this.config.actionSize }, (_, action) =>
        batch.legalActionMask.data[row * this.config.actionSize + action] === 1
          ? mean + (action + 1) / this.config.actionSize
          : Number.NEGATIVE_INFINITY
      );
      const max = Math.max(...logits);
      const weights = logits.map((logit) => (Number.isFinite(logit) ? Math.exp(logit - max) : 0));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      policy.push(...weights.map((weight) => weight / total));
    }
    return {
      policy: { dtype: 'float32', shape: [batchSize, this.config.actionSize], data: policy },
      value: { dtype: 'float32', shape: [batchSize, 1], data: value },
    };
  }

  async close(): Promise<void> {}
}

/** Validated adapter for a Rust FFI bridge or remote inference service. */
export class TransportPtcgNeuralBackend extends CheckedBackend {
  readonly id: string;
  readonly capabilities: PtcgNeuralCapabilities;

  constructor(
    configValue: PtcgNeuralBackendConfig,
    private readonly transport: PtcgNeuralTransport
  ) {
    const config = validatePtcgNeuralConfig(configValue);
    if (config.transport === 'in-process')
      throw new Error('transport backend requires ffi or service transport');
    super(config);
    this.id = config.backend;
    this.capabilities = {
      maxBatchSize: config.maxBatchSize,
      dtypes: ['float32'],
      transport: config.transport,
      deterministic: true,
    };
  }

  protected inferChecked(batch: PtcgPolicyValueBatch): Promise<PtcgPolicyValueOutput> {
    return this.transport.invoke({ apiVersion: PTCG_NEURAL_API_VERSION, backend: this.id, batch });
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }
}

export async function comparePtcgNeuralBackends(
  backends: readonly PtcgNeuralBackend[],
  batch: PtcgPolicyValueBatch,
  tolerance = 1e-6
): Promise<PtcgPolicyValueOutput[]> {
  if (backends.length < 2) throw new Error('backend comparison requires at least two backends');
  const outputs = await Promise.all(backends.map((backend) => backend.infer(batch)));
  const reference = [...outputs[0].policy.data, ...outputs[0].value.data];
  outputs.slice(1).forEach((output, index) => {
    const candidate = [...output.policy.data, ...output.value.data];
    if (
      candidate.length !== reference.length ||
      candidate.some((value, i) => Math.abs(value - reference[i]) > tolerance)
    ) {
      throw new Error(`neural backend output mismatch: ${backends[index + 1].id}`);
    }
  });
  return outputs;
}
