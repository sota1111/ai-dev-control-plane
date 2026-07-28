# SOT-2086 — third-cycle ARC-AGI-3 GPT champion evidence

## Promotion decision

SOT-2085 did not promote `stateful-frame-difference-v1`: its favorable
screen→confirm result used only synthetic production-shaped replay
(`productionEvidence: false`). The candidate behavior was reverted, so the
registered champion remains `observation-rule-v1`.

- Registry candidate: `observation-rule-v1`
- Artifact: `git:01d8177`
- Evaluation fingerprint:
  `339695bade7dba7fd964558e407984d0842168544a0cbf4d8825414b96042218`
- Original promotion screen: passed (seeds 101–106, mean score 4)
- Independent confirm: passed (seeds 201–210, mean score 4)
- SOT-2085 candidate: not promoted and reverted

## Exec and package identity

The dependency-free JSONL entrypoint and self-contained Kaggle source are
fingerprinted in `scripts/ai/kaggle_targets_registry.json`.

- Exec source SHA-256:
  `f4b4fd4ee361a21332339328fa70159aa2fc2ed9584afd09edf7a842e34f4c1d`
- Committed kernel source SHA-256:
  `3726cef74d2ced618b6a9f4fd282c56a307c08fae0ffd1ab18e50408796213f2`
- Pulled Kaggle version 4 source SHA-256:
  `3726cef74d2ced618b6a9f4fd282c56a307c08fae0ffd1ab18e50408796213f2`
- Byte comparison between committed and pulled source: equal
- Kernel: `sota1111/arc-agi-3-gpt-registered-champion`, version 4
- Kernel status: `KernelWorkerStatus.COMPLETE`

Version 4 embeds the registered champion adapter in its sole Kaggle code file;
the competition rerun no longer depends on an adjacent, unpublished
`champion_agent.py`.

The exec contract tests verify registry identity, screen→confirm lineage,
standard-input/standard-output JSONL behavior, legal output schema,
determinism, malformed/invalid input failure with exit 2, and zero faults for
valid fixtures.

## Submission attempt

- Attempted at: `2026-07-28T10:08:27Z`
- Target: kernel version 4, `submission.parquet`
- Result: no submission created
- Exact API result:
  `400 Client Error: Bad Request ... CreateCodeSubmission`
- Submission ref / status / score: N/A because Kaggle allocated no ref

The concrete skip reason is the shared ARC-AGI-3 daily quota. The registry cap
is one submission per UTC day, and ref `55043609` had already consumed the
2026-07-28 slot at `2026-07-28T02:56:47.883Z`; it completed with public score
`0.14`. That ref belongs to the Claude champion and is not claimed as this GPT
champion's result. Credentials, kernel publication, kernel completion, output
configuration, and source identity were all available, so version 4 remains
ready for the next eligible GPT slot.

## Gate conclusion

The non-promotion/revert rule was preserved, the incumbent identity is pinned
from evaluation through exec and the published artifact, all exec gates pass,
and the attempted Kaggle submission has a specific external quota skip.
