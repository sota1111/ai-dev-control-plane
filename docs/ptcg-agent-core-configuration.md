# PTCG agent core configuration and adapter contract

`src/lib/ptcgAgentCore.ts` defines the configuration and runtime boundary shared by 松・竹・梅 and
Zero. Persisted configurations always carry `schemaVersion`; adapters advertise the API contract they
implement separately from their implementation version.

## Current configuration

The writer format is `ptcg-agent-core/v2`. Required fields are explicit after defaults are applied:

```json
{
  "schemaVersion": "ptcg-agent-core/v2",
  "agent": { "id": "matsu", "entrypoint": "main.agent" },
  "runtime": { "seed": 0, "timeoutMs": 30000, "maxRetries": 0 },
  "compatibility": { "adapterApi": "ptcg-agent-adapter/v1" }
}
```

Use `parsePtcgAgentConfig` at trust boundaries. It parses, migrates supported older input, applies
defaults and performs strict validation. Use `encodePtcgAgentConfig` for canonical JSON serialization.
Unknown fields and unsupported versions are rejected so misspellings cannot silently change a run.

## Versioning and migration policy

- Additive changes with an unambiguous default may stay in the current schema. Readers normalize the
  omitted field; writers emit it explicitly.
- A removed/renamed field, changed meaning/default, or incompatible type requires a new schema version.
- Readers support the current version and the immediately preceding version. Migration is forward-only,
  deterministic, pure, and must not use environment values, clocks, network access, or filesystem state.
- `ptcg-agent-core/v1` is currently supported. It migrates flat `agentId`, `entrypoint`, optional `seed`
  and `timeoutMs` into v2; `maxRetries` defaults to `0` and adapter API to v1.
- Writers only emit the current version. Downgrade is not supported. Unknown/future versions fail with
  an actionable error instead of being guessed.
- Before removing a supported reader version, ship and document its migration for at least one release,
  update fixtures, and announce the breaking change. Persist migrated output before the old reader is
  removed if long-lived configuration files are involved.

Every version must have round-trip, invalid-input, defaulting and migration fixtures. A migration must
preserve the effective agent entrypoint, seed and timeout.

## Adapter API

All four agents implement `PtcgAgentAdapter` with API version `ptcg-agent-adapter/v1`:

1. `initialize(validatedCurrentConfig)` prepares bounded runtime state.
2. `invoke(request)` handles the shared match request and returns score, latency, fallback and optional
   structured fault data.
3. `close()` releases resources and is safe after successful initialization.

`id` is the stable machine identity (`matsu`, `take`, `ume`, `zero`); `displayName` is presentation only.
`implementationVersion` identifies the concrete adapter build and does not replace `apiVersion`.
Changing request/response or lifecycle semantics requires a new adapter API version and an explicit
compatibility declaration in the configuration schema.
