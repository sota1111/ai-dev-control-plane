# SOT-2181 — ARC-AGI-2 GPT champion kernel consistency and submission evidence

## Promotion decision and champion

- SOT-2180 rejected both pre-specified mixed-dimension candidates after the
  fixed screen produced zero positive exact wins. Confirm was not run and no
  candidate was promoted.
- The target repository `sota1111/arc-agi-2-gpt` was checked at
  `origin/main` revision `e87f3472d17008720a98ee51add5ca4099832ca9`.
- Its `registry.json` records `champion = identity`.
- The target `main.py`, committed kernel `submission.py`, source downloaded
  from the published Kaggle kernel, and control-plane registry all have
  SHA-256
  `94dc28395abe6c5046d1bf9af8376913e5a83aaa8fe11164656f54195f1f1a8b`.
- The control-plane registry also records `candidate_id = identity`.

The non-promotion decision and all four champion representations are
consistent. No solver, runtime, kernel source, or registry change was needed.

## Exec and schema gate

`src/__tests__/arcAgi2GptChampionExec.test.ts` executes the committed source
from an unrelated temporary working directory without a repository import
path or network dependency. It verifies challenge discovery without
`__file__`, every test case's two-attempt schema, deterministic identity
outputs, fail-closed grid validation, and the registry fingerprint.

The real output downloaded from the published kernel was also parsed:

- task IDs: 240
- test cases: 259
- malformed attempt objects: 0
- output size: 266,131 bytes
- output SHA-256:
  `2ee50d49cd06785b078f6c012fdbb19a9460b96db77e60b5b0b653f25e61c287`

## Kernel and artifact status

- Kernel: `sota1111/arc-agi-2-gpt-identity-champion`
- Registry version: 4
- Status checked on 2026-07-29 UTC:
  `KernelWorkerStatus.COMPLETE`
- Output: `submission.json`
- Published source fingerprint:
  `sha256:94dc28395abe6c5046d1bf9af8376913e5a83aaa8fe11164656f54195f1f1a8b`

The published COMPLETE kernel is already byte-identical to the incumbent, so
publishing a duplicate version was intentionally skipped.

## Alternate order, daily cap, and idempotent submission

The latest competition submission was the Claude lineage and had already
consumed the shared UTC-day slot:

- Submission ref: `55090366`
- Created: `2026-07-29T19:00:17.247000Z`
- Description: `auto-improve submit: arc-agi-2-claude champion`
- Status: `SubmissionStatus.COMPLETE`
- Public score: `0.00`
- Private score: not reported

On 2026-07-29 UTC,
`scripts/ai/kaggle_targets_submit.sh --competition arc-agi-2 --execute`
produced `submission_mode = alternate`, selected Claude for the current turn,
and allocated no new submission:

- Claude: skipped because it had already submitted today (idempotent,
  no double submit; shared cap 1/1).
- GPT: skipped because the current alternate turn is Claude and GPT is next.

This is the required safe skip. The current GPT champion remains the COMPLETE
version 4 kernel, with successful prior submission ref `55050349`
(`SubmissionStatus.COMPLETE`, public score `0.00`) available as the latest GPT
submission evidence.
