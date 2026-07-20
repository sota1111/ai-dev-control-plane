# PTCG benchmark release gate

Pull requests run `npm run benchmark:smoke` after lint, typecheck, and unit tests. A weekly and manually
dispatchable workflow runs the larger `npm run benchmark:scheduled`. Both use the versioned fixture
engine, seed `1786`, fixed deck hash, fixed opponent snapshot, paired seat orientations, and a versioned
baseline. Any correctness regression/inconclusive result, runtime above `BENCHMARK_MAX_DURATION_MS`, or
unredacted secret/email/host path exits non-zero and blocks the workflow.

Each run uploads `release-gate.json` and `release-gate.md`. The JSON binds the result to the conditions
fingerprint and contains each gate's evidence; the Markdown file is the lightweight dashboard for an
independent reviewer. PR artifacts are retained for 30 days and scheduled artifacts for 90 days.

## Reproduce locally

```bash
npm ci
BENCHMARK_GENERATED_AT=2026-07-20T00:00:00.000Z npm run benchmark:smoke -- artifacts/ptcg-release-gate
npm run benchmark:scheduled -- artifacts/ptcg-release-gate
```

The fixed timestamp makes correctness evidence byte-comparable. Runtime remains observed evidence and
may vary; adjust the performance ceiling only through the `BENCHMARK_MAX_DURATION_MS` environment
variable, with a reviewed explanation.

## Failure analysis runbook

1. Download the workflow artifact and open `release-gate.md`; identify the failed gate.
2. For `correctness`, inspect classifications and protocol fingerprints in `release-gate.json`. A
   changed fingerprint means the candidate and baseline conditions are not comparable; restore the
   pinned seed/deck/opponent/environment or intentionally version the baseline.
3. For `performance`, reproduce with the same Node version and command. Compare multiple scheduled
   runs before changing the ceiling; investigate runner or algorithm changes when the regression is
   stable.
4. For `information-leakage`, do not publish the rejected output. Find the sensitive field at the
   persistence boundary and pass it through `redactArtifact`; add a negative regression test.
5. Re-run the smoke command. Release only when all three checks report `PASS`; never override a failed
   artifact manually.
