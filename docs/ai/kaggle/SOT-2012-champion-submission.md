# SOT-2012 — ARC-AGI-2 GPT champion kernel evidence

## Champion identity

- SOT-2009 conclusion: non-promotion; `identity` remains the incumbent champion.
- Target repository merge: `b19405bef45fd66d5c3221adfb97542fe3654a3a`.
- Target registry: `champion = identity`.
- Target `main.py` SHA-256:
  `94dc28395abe6c5046d1bf9af8376913e5a83aaa8fe11164656f54195f1f1a8b`.
- Packaged `submission.py` SHA-256:
  `94dc28395abe6c5046d1bf9af8376913e5a83aaa8fe11164656f54195f1f1a8b`.
- Fingerprint conclusion: byte-for-byte equal (`cmp` exit 0).

The rejected SOT-2009 candidate did not change `registry.json`, `main.py`, or
production solver behavior, so the incumbent identity runtime is the required
submission artifact.

## Exec and schema gate

`src/__tests__/arcAgi2GptChampionExec.test.ts` runs the packaged source with an
unrelated current working directory, no project import path or network access,
and challenge/output locations supplied only through environment variables.
It verifies deterministic identity attempts, the required
`task_id -> [{attempt_1, attempt_2}]` shape, rectangular/color validation, and
fail-closed behavior. The same test recalculates the source SHA-256 and requires
an exact match with the registry fingerprint.

## Kernel publication

- Kernel: `sota1111/arc-agi-2-gpt-identity-champion`
- Version: 3
- Competition source: `arc-prize-2026-arc-agi-2`
- Internet/GPU: disabled
- Status after publication: `KernelWorkerStatus.COMPLETE`
- Output: `submission.json` (857 bytes)

The metadata title normalized to the actual Kaggle slug
`arc-agi-2-gpt-identity-champion`; registry and committed metadata use that
real slug.

## Alternate order and submission attempt

At attempt time, the latest competition submission was Claude lineage: ref
`55016869`, description `SOT-2011 Claude identity champion`, created
`2026-07-27 02:56:37.823000`, status `SubmissionStatus.COMPLETE`, public score
`0.00`. The deterministic planner therefore selected GPT and skipped Claude.

The GPT version 3 submission was attempted with:

```text
kaggle competitions submit -c arc-prize-2026-arc-agi-2 \
  -k sota1111/arc-agi-2-gpt-identity-champion -v 3 \
  -f submission.json \
  -m "SOT-2012 GPT identity champion sha256:94dc28395abe"
```

Kaggle rejected creation before allocating a submission ref:

```text
400 Client Error: Bad Request for url:
https://api.kaggle.com/v1/competitions.CompetitionApiService/CreateCodeSubmission
```

The registry cap is one submission per day, and ref `55016869` already consumed
the current UTC-day slot. Therefore this attempt has no ref/status/score. The
COMPLETE, fingerprint-pinned kernel version 3 remains ready for the next
available GPT slot without rebuilding.

