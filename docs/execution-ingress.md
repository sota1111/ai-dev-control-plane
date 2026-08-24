# Linear execution ingress

`ai-dev-control-plane` is an execution consumer. It does not decide or schedule what research work
should exist. Human operators and approved producers create Linear issues; the primary automated
producer is the separate `epistemic-research-loop` repository.

## Ingress sequence

```text
Linear issue create/update
  -> HMAC verification over the raw request body
  -> delivery de-duplication
  -> optional ERL ExperimentRequest validation
  -> terminal/hold/archive and meaningful-update gates
  -> persistent priority queue
  -> worker selection and execution
  -> Linear/GitHub/result artifacts
```

Startup and reaper scans reconcile current Linear state after missed webhook delivery or process
restart. They may enqueue existing active issues, but never create an issue.

## Epistemic Research Loop contract

The optional contract begins with:

```text
<!-- epistemic-research-loop:experiment-request:v1 -->
ERL-IDEMPOTENCY: <run-id>:<experiment-id>:attempt-<N>
```

The JSON block is validated by `src/lib/experimentRequest.ts`. Required fields include request,
experiment, run and idempotency identifiers, immutable base commit, objective and command, container
image, read-only named dataset mounts, bounded resources and timeout, unique seeds, safe relative
required outputs, and a declared network policy. A marked but invalid contract is acknowledged as
ignored and is never queued. Unmarked human issues remain backwards compatible.

The result writer must place the versioned `ExperimentResult` in the artifact/result location
declared by the producer. Scores from sealed holdouts or Kaggle leaderboards must not be written into
Linear comments or normal research events.

## Removing the legacy drafter

Run `bash scripts/ai/setup_cron.sh` once on existing hosts. It removes historical `run_auto`, Kaggle,
Sonnet, and NEDO drafting cron entries and registers no replacement. Start ingress with
`npm run start:webhook`.
