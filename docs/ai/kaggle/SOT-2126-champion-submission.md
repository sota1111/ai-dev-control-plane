# SOT-2126 — ARC-AGI-2 GPT champion kernel consistency and submission evidence

## Promotion decision and champion

- SOT-2125 concluded that both pre-specified pattern-completion candidates had
  zero positive exact wins in the fixed screen. Confirm was therefore not run
  and neither candidate was promoted.
- The target repository `sota1111/arc-agi-2-gpt` was checked at
  `origin/main` revision `e87f3472d17008720a98ee51add5ca4099832ca9`.
- Its `registry.json` still records `champion = identity`.
- The target `main.py`, committed kernel `submission.py`, and source pulled from
  the published Kaggle kernel all have SHA-256
  `94dc28395abe6c5046d1bf9af8376913e5a83aaa8fe11164656f54195f1f1a8b`.
- The control-plane registry pins the same fingerprint with
  `candidate_id = identity`.

The non-promotion conclusion, target registry, packaged runtime, published
kernel, and control-plane registry are therefore consistent. No solver or
runtime change was required.

## Exec and schema gate

`src/__tests__/arcAgi2GptChampionExec.test.ts` executes the committed source
from an unrelated temporary working directory with no repository import path
or network dependency. It verifies:

- challenge discovery without `__file__`;
- every test task and test case is present in `submission.json`;
- every case contains exactly `attempt_1` and `attempt_2`;
- both identity attempts preserve the input grid;
- invalid, ragged, or out-of-range grids fail closed; and
- the runtime fingerprint exactly matches the registry.

## Kernel and artifact status

- Kernel: `sota1111/arc-agi-2-gpt-identity-champion`
- Registered version: `4`
- Status checked on 2026-07-28 UTC:
  `KernelWorkerStatus.COMPLETE`
- Output: `submission.json` (857 bytes)
- Downloaded output SHA-256:
  `2ee50d49cd06785b078f6c012fdbb19a9460b96db77e60b5b0b653f25e61c287`
- Real output schema replay: 240 task IDs, 259 test cases, zero missing or
  malformed attempt objects
- Published source fingerprint:
  `sha256:94dc28395abe6c5046d1bf9af8376913e5a83aaa8fe11164656f54195f1f1a8b`

Because the published COMPLETE kernel was already byte-identical to the
incumbent, publishing a duplicate kernel version was intentionally skipped.

## Alternate order, daily cap, and idempotent submission

The current champion had already been submitted successfully in the current
UTC day:

- Submission ref: `55050349`
- Created: `2026-07-28T08:59:17.633000Z`
- Description: `auto-improve submit: arc-agi-2-gpt identity champion`
- Kernel version: `4`
- Status: `SubmissionStatus.COMPLETE`
- Public score: `0.00`
- Private score: not reported

At `2026-07-28T20:17:34Z`,
`scripts/ai/kaggle_targets_submit.sh --competition arc-agi-2 --execute`
recorded an execute-mode plan with `submission_mode = alternate`,
`daily_submission_cap = 1`, `submittedToday = 1`, and no new submission. GPT
was skipped because the previous lineage was GPT and the next alternate
lineage is Claude; the already-consumed shared daily slot independently makes
a second submission invalid. This is the required idempotent outcome: the
successful current-champion ref above remains the evidence, and no duplicate
ref was allocated.
