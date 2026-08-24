# ai-dev-control-plane design

This repository is a code-implementation execution service. It accepts authenticated Linear
webhooks and versioned execution requests, resolves the target repository, queues work, dispatches a
configured coding worker, verifies completion, and reports the result.

## Responsibilities

- Verify webhook signatures and de-duplicate deliveries.
- Translate actionable issues into durable queue items.
- Resolve repository and isolated worktree ownership.
- Select a coding worker and enforce per-repository serialization.
- Retry infrastructure and usage-limit failures without duplicating work.
- Run implementation, test, review, and completion-report stages.
- Record logs, result contracts, and Linear state transitions.

## Explicitly out of scope

- Domain-specific research planning or issue creation.
- Dataset analysis, model selection, and experiment prioritization.
- External evaluation submission, score retrieval, or ranking optimization.
- Domain-specific simulators, evaluation engines, and generated evidence.

Those concerns belong to producer or evaluator repositories. They may submit an
`ExperimentRequest`, but this service treats its objective and artifacts as opaque implementation
inputs and never feeds evaluation results into planning.

## Execution flow

```text
authenticated webhook / ExperimentRequest
  -> eligibility and repository resolution
  -> durable queue
  -> isolated worker execution
  -> implementation verification and review
  -> ExperimentResult / Linear completion report
```

All state-changing operations are idempotent. Secrets are loaded at runtime and must not appear in
prompts, logs, queue files, artifacts, or source control.
