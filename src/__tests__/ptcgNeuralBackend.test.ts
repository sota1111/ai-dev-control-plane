import {
  PTCG_NEURAL_API_VERSION,
  ReferencePtcgNeuralBackend,
  TransportPtcgNeuralBackend,
  comparePtcgNeuralBackends,
  validatePtcgNeuralConfig,
  type PtcgNeuralBackendConfig,
  type PtcgNeuralTransport,
  type PtcgPolicyValueBatch,
} from '../lib/ptcgNeuralBackend.js';

const referenceConfig: PtcgNeuralBackendConfig = {
  schemaVersion: 'ptcg-neural-config/v1',
  backend: 'typescript-reference',
  featureSize: 3,
  actionSize: 4,
  maxBatchSize: 8,
  transport: 'in-process',
};

const batch: PtcgPolicyValueBatch = {
  features: { dtype: 'float32', shape: [2, 3], data: [1, 0, -1, 2, 1, 0] },
  legalActionMask: { dtype: 'float32', shape: [2, 4], data: [1, 0, 1, 1, 0, 1, 1, 0] },
};

describe('pluggable Policy/Value neural backend', () => {
  it('implements the shared contract with stable policy/value shapes and dtype', async () => {
    const backend = new ReferencePtcgNeuralBackend(referenceConfig);
    const output = await backend.infer(batch);
    expect(backend.apiVersion).toBe(PTCG_NEURAL_API_VERSION);
    expect(backend.capabilities).toEqual({
      maxBatchSize: 8,
      dtypes: ['float32'],
      transport: 'in-process',
      deterministic: true,
    });
    expect(output.policy).toMatchObject({ dtype: 'float32', shape: [2, 4] });
    expect(output.value).toMatchObject({ dtype: 'float32', shape: [2, 1] });
    expect(output.policy.data[1]).toBe(0);
    expect(output.policy.data.slice(0, 4).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  });

  it('compares reference and accelerated transports on the identical fixture', async () => {
    const reference = new ReferencePtcgNeuralBackend(referenceConfig);
    let captured: unknown;
    const transport: PtcgNeuralTransport = {
      async invoke(request) {
        captured = request;
        return reference.infer(request.batch);
      },
    };
    const accelerated = new TransportPtcgNeuralBackend(
      { ...referenceConfig, backend: 'rust-ffi', transport: 'ffi', endpoint: 'libptcg_nn.so' },
      transport
    );
    await expect(comparePtcgNeuralBackends([reference, accelerated], batch)).resolves.toHaveLength(
      2
    );
    expect(captured).toMatchObject({
      apiVersion: PTCG_NEURAL_API_VERSION,
      backend: 'rust-ffi',
      batch,
    });
  });

  it.each([
    [{ ...batch, features: { ...batch.features, shape: [2, 2] } }, /features.shape/],
    [{ ...batch, features: { ...batch.features, dtype: 'float64' } }, /dtype must be float32/],
    [
      { ...batch, features: { ...batch.features, shape: [9, 3], data: Array(27).fill(0) } },
      /exceeds maximum/,
    ],
    [
      { ...batch, legalActionMask: { ...batch.legalActionMask, data: [0, 0, 0, 0, 0, 1, 1, 0] } },
      /no legal action/,
    ],
  ])('rejects invalid shape, dtype, or batch boundaries %#', async (candidate, message) => {
    await expect(
      new ReferencePtcgNeuralBackend(referenceConfig).infer(candidate as PtcgPolicyValueBatch)
    ).rejects.toThrow(message);
  });

  it('rejects an invalid response returned across the service boundary', async () => {
    const backend = new TransportPtcgNeuralBackend(
      {
        ...referenceConfig,
        backend: 'service',
        transport: 'service',
        endpoint: 'http://inference.invalid',
      },
      {
        async invoke() {
          return {
            policy: { dtype: 'float32', shape: [1, 4], data: [1, 0, 0, 0] },
            value: { dtype: 'float32', shape: [1, 1], data: [0] },
          };
        },
      }
    );
    await expect(backend.infer(batch)).rejects.toThrow(/policy.shape/);
  });

  it('validates capability configuration and external endpoint requirements', () => {
    expect(validatePtcgNeuralConfig(referenceConfig)).toEqual(referenceConfig);
    expect(() => validatePtcgNeuralConfig({ ...referenceConfig, transport: 'ffi' })).toThrow(
      /requires endpoint/
    );
    expect(() => validatePtcgNeuralConfig({ ...referenceConfig, maxBatchSize: 0 })).toThrow(
      /positive/
    );
  });

  it('reports a fixture mismatch from a divergent accelerated backend', async () => {
    const reference = new ReferencePtcgNeuralBackend(referenceConfig);
    const divergent = new TransportPtcgNeuralBackend(
      { ...referenceConfig, backend: 'divergent', transport: 'ffi', endpoint: 'fixture' },
      {
        async invoke(request) {
          const output = await reference.infer(request.batch);
          return { ...output, value: { ...output.value, data: output.value.data.map(() => 1) } };
        },
      }
    );
    await expect(comparePtcgNeuralBackends([reference, divergent], batch)).rejects.toThrow(
      /output mismatch: divergent/
    );
  });
});
