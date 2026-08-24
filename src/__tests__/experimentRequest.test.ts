import { EXPERIMENT_REQUEST_MARKER, parseExperimentRequest } from '../lib/experimentRequest.js';

function description(overrides: Record<string, unknown> = {}): string {
  const request = {
    request_id: 'req-001',
    experiment_id: 'exp-001',
    run_id: 'run-001',
    idempotency_key: 'run-001:exp-001:attempt-1',
    base_commit_sha: 'abc123',
    implementation_mode: 'patch_existing_solver',
    objective: 'Compare random CV and temporal CV',
    command: 'python -m solver.run --config generated/exp-001.yaml',
    container_image: 'solver:sha256-abc',
    dataset_mounts: [{ name: 'input-data', read_only: true }],
    resources: { cpu: 8, memory_gb: 32, gpu: 0, timeout_seconds: 7200 },
    seeds: [11, 23, 37],
    required_outputs: ['metrics.json', 'fold_metrics.json'],
    network_policy: 'disabled',
    ...overrides,
  };
  return `${EXPERIMENT_REQUEST_MARKER}\n\n\`\`\`json\n${JSON.stringify(request)}\n\`\`\``;
}

describe('epistemic experiment request ingress contract', () => {
  test('ordinary Linear issues remain outside the optional contract', () => {
    expect(parseExperimentRequest('human-authored task')).toEqual({ kind: 'none' });
  });

  test('accepts a complete versioned request', () => {
    const result = parseExperimentRequest(description());
    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.request.experiment_id).toBe('exp-001');
      expect(result.request.network_policy).toBe('disabled');
    }
  });

  test('rejects an idempotency key for a different run', () => {
    const result = parseExperimentRequest(
      description({ idempotency_key: 'other:exp-001:attempt-1' })
    );
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') expect(result.reason).toMatch(/scoped/);
  });

  test('rejects writable dataset mounts and path traversal outputs', () => {
    expect(
      parseExperimentRequest(
        description({
          dataset_mounts: [{ name: 'data', read_only: false }],
        })
      ).kind
    ).toBe('invalid');
    expect(parseExperimentRequest(description({ required_outputs: ['../score.json'] })).kind).toBe(
      'invalid'
    );
  });

  test('rejects malformed marked JSON', () => {
    expect(
      parseExperimentRequest(`${EXPERIMENT_REQUEST_MARKER}\n\`\`\`json\n{bad}\n\`\`\``).kind
    ).toBe('invalid');
  });
});
