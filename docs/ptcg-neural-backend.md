# PTCG Policy／Value neural backend contract

`src/lib/ptcgNeuralBackend.ts` defines the versioned inference boundary shared by portable and accelerated neural-network implementations.

- Input tensors are row-major `float32`: features `[batch, featureSize]` and legal-action masks `[batch, actionSize]`.
- Outputs are policy probabilities `[batch, actionSize]` and scalar values `[batch, 1]`, with values constrained to `[-1, 1]`.
- Every request validates shape, dtype, finite values, maximum batch size, and at least one legal action per row. Every backend response is validated again at the boundary.
- `ReferencePtcgNeuralBackend` is a deterministic in-process implementation and fixture oracle.
- `TransportPtcgNeuralBackend` accepts the JSON-safe `PtcgNeuralTransport` interface. A Rust shared-library bridge (`ffi`) or inference endpoint (`service`) can therefore replace the implementation without changing callers.
- `PtcgNeuralCapabilities` advertises transport, supported dtypes, deterministic behavior, and maximum batch size. `ptcg-neural-config/v1` pins feature/action sizes and the external endpoint.

Use `comparePtcgNeuralBackends` with a shared fixture to ensure an accelerated implementation stays within the selected numeric tolerance of the reference output.
