import type {
  PtcgNeuralBackend,
  PtcgPolicyValueBatch,
  PtcgPolicyValueOutput,
} from './ptcgNeuralBackend.js';

export const PTCG_POLICY_INFERENCE_RUNTIME_VERSION = 'ptcg-policy-inference-runtime/v1' as const;

/** Backend-independent entry point used by callers that need policy/value inference. */
export interface PtcgPolicyInferenceRuntime {
  readonly apiVersion: typeof PTCG_POLICY_INFERENCE_RUNTIME_VERSION;
  register(backend: PtcgNeuralBackend): this;
  backendIds(): string[];
  infer(backendId: string, batch: PtcgPolicyValueBatch): Promise<PtcgPolicyValueOutput>;
  close(): Promise<void>;
}

/**
 * Owns registered policy backends and routes inference by stable backend id.
 * Backend validation remains inside each adapter, keeping the runtime transport-agnostic.
 */
export class SharedPtcgPolicyInferenceRuntime implements PtcgPolicyInferenceRuntime {
  readonly apiVersion = PTCG_POLICY_INFERENCE_RUNTIME_VERSION;
  private readonly backends = new Map<string, PtcgNeuralBackend>();
  private closed = false;

  register(backend: PtcgNeuralBackend): this {
    this.assertOpen();
    if (!backend.id.trim()) throw new Error('policy backend id must be non-empty');
    if (this.backends.has(backend.id)) {
      throw new Error(`policy backend already registered: ${backend.id}`);
    }
    this.backends.set(backend.id, backend);
    return this;
  }

  backendIds(): string[] {
    return [...this.backends.keys()];
  }

  infer(backendId: string, batch: PtcgPolicyValueBatch): Promise<PtcgPolicyValueOutput> {
    this.assertOpen();
    const backend = this.backends.get(backendId);
    if (!backend) {
      const available = this.backendIds();
      const suffix = available.length ? `; available: ${available.join(', ')}` : '';
      throw new Error(`unregistered policy backend: ${backendId}${suffix}`);
    }
    return backend.infer(batch);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const results = await Promise.allSettled(
      [...this.backends.values()].map((backend) => backend.close())
    );
    this.backends.clear();
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failure) throw failure.reason;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('policy inference runtime is closed');
  }
}
