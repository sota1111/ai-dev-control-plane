import {
  PTCG_NEURAL_API_VERSION,
  ReferencePtcgNeuralBackend,
  TransportPtcgNeuralBackend,
  type PtcgNeuralBackendConfig,
  type PtcgPolicyValueBatch,
} from '../lib/ptcgNeuralBackend.js';
import {
  PTCG_POLICY_INFERENCE_RUNTIME_VERSION,
  SharedPtcgPolicyInferenceRuntime,
  type PtcgPolicyInferenceRuntime,
} from '../lib/ptcgPolicyInferenceRuntime.js';

const batch: PtcgPolicyValueBatch = {
  features: { dtype: 'float32', shape: [1, 2], data: [0.25, 0.75] },
  legalActionMask: { dtype: 'float32', shape: [1, 3], data: [1, 0, 1] },
};

const config = (
  backend: string,
  transport: PtcgNeuralBackendConfig['transport']
): PtcgNeuralBackendConfig => ({
  schemaVersion: 'ptcg-neural-config/v1',
  backend,
  featureSize: 2,
  actionSize: 3,
  maxBatchSize: 4,
  transport,
  ...(transport === 'in-process' ? {} : { endpoint: 'memory://policy' }),
});

describe('shared PTCG policy inference runtime', () => {
  it('selects and runs two policy backend adapters through one interface', async () => {
    const reference = new ReferencePtcgNeuralBackend(config('reference', 'in-process'));
    const transported = new TransportPtcgNeuralBackend(config('transported', 'service'), {
      async invoke(request) {
        expect(request).toMatchObject({
          apiVersion: PTCG_NEURAL_API_VERSION,
          backend: 'transported',
        });
        return reference.infer(request.batch);
      },
    });
    const runtime: PtcgPolicyInferenceRuntime = new SharedPtcgPolicyInferenceRuntime()
      .register(reference)
      .register(transported);

    expect(runtime.apiVersion).toBe(PTCG_POLICY_INFERENCE_RUNTIME_VERSION);
    expect(runtime.backendIds()).toEqual(['reference', 'transported']);
    const direct = await runtime.infer('reference', batch);
    const remote = await runtime.infer('transported', batch);
    expect(remote).toEqual(direct);
    expect(direct.policy.shape).toEqual([1, 3]);
  });

  it('reports an unregistered backend and lists valid selections', () => {
    const runtime = new SharedPtcgPolicyInferenceRuntime().register(
      new ReferencePtcgNeuralBackend(config('reference', 'in-process'))
    );

    expect(() => runtime.infer('missing', batch)).toThrow(
      'unregistered policy backend: missing; available: reference'
    );
  });

  it('rejects duplicate registration and closes every owned backend once', async () => {
    const closed: string[] = [];
    const reference = new ReferencePtcgNeuralBackend(config('reference', 'in-process'));
    const transported = new TransportPtcgNeuralBackend(config('transported', 'ffi'), {
      invoke: (request) => reference.infer(request.batch),
      close: async () => {
        closed.push('transported');
      },
    });
    const runtime = new SharedPtcgPolicyInferenceRuntime()
      .register(reference)
      .register(transported);

    expect(() => runtime.register(reference)).toThrow(
      'policy backend already registered: reference'
    );
    await runtime.close();
    await runtime.close();
    expect(closed).toEqual(['transported']);
    expect(() => runtime.infer('reference', batch)).toThrow('policy inference runtime is closed');
  });
});
