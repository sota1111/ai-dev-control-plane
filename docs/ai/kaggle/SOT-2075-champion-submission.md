# SOT-2075 — ARC-AGI-2 GPT champion submission evidence

## Champion and fingerprint

- SOT-2074 conclusion: `component-attribute-bbox-v1` was not promoted; the
  `identity` incumbent remains the current champion.
- Target repository revision checked: `04aba29`.
- Target `registry.json`: `champion = identity`.
- Target `main.py` SHA-256:
  `94dc28395abe6c5046d1bf9af8376913e5a83aaa8fe11164656f54195f1f1a8b`.
- Committed kernel `submission.py` SHA-256:
  `94dc28395abe6c5046d1bf9af8376913e5a83aaa8fe11164656f54195f1f1a8b`.
- Pulled Kaggle kernel source SHA-256:
  `94dc28395abe6c5046d1bf9af8376913e5a83aaa8fe11164656f54195f1f1a8b`.

All three sources are byte-for-byte identical. The control-plane registry pins
the same fingerprint and `candidate_id = identity`.

## Exec and schema gate

The source passed the stdin `exec(compile(...))` gate from an unrelated
temporary working directory with no `__file__`, repository import, or network
dependency. A two-task/three-test fixture produced valid
`task_id -> [{attempt_1, attempt_2}]` JSON, and both attempts deterministically
matched the identity champion. The committed Jest contract also checks
fail-closed rectangular/color validation.

## Kernel publication

- Kernel: `sota1111/arc-agi-2-gpt-identity-champion`
- Version: 4
- Competition source: `arc-prize-2026-arc-agi-2`
- Internet/GPU: disabled
- Status after publication: `KernelWorkerStatus.COMPLETE`
- Output: `submission.json`

The submission registry now points at the COMPLETE version 4 kernel.

## Alternate order, cap, and submission

At planning time, the latest previous ARC submission was Claude lineage ref
`55016869` from `2026-07-27T02:56:37.823000Z`. There was no submission on
`2026-07-28` UTC, so the `alternate` planner selected GPT and skipped Claude.
The shared daily cap is one.

- Submission ref: `55050349`
- Created: `2026-07-28T08:59:17.633000Z`
- Description: `auto-improve submit: arc-agi-2-gpt identity champion`
- Kernel version: 4
- Status: `SubmissionStatus.COMPLETE`
- Public score: `0.00`
- Private score: not reported
- Remaining daily submissions reported by Kaggle: 0

The submission completed successfully and consumed the single daily slot.
