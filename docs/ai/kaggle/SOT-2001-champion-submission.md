# SOT-2001 — ARC-AGI-3 GPT champion submission evidence

## Submitted artifact identity

- Registry candidate: `observation-rule-v1`
- Artifact: `git:01d8177`
- Evaluation fingerprint:
  `339695bade7dba7fd964558e407984d0842168544a0cbf4d8825414b96042218`
- Screen: passed (`meanScore=4`, seeds 101–106)
- Independent confirm: executed and passed (`meanScore=4`, seeds 201–210)
- Kernel: `sota1111/arc-agi-3-gpt-registered-champion`, version 3
- Kernel status: `COMPLETE`
- Competition: `arc-prize-2026-arc-agi-3`

The exec manifest is checked directly against
`artifacts/arc-agi-3/sot-1958/champion.json`; its evaluation fingerprint is
resolved back to the passing screen/confirm record in `decision.json`.

## Exec contract

`scripts/ai/arc_agi3_champion_exec.py` accepts one production `FrameData` JSON
object per stdin line and emits one legal `GameAction` JSON object per stdout
line. It is dependency-free, deterministic, exits zero only after processing
all records, and fails closed with exit 2 on malformed JSON or invalid contract
fields. The official Kaggle framework adapter packages the same registered
policy as `Champion`.

## Kaggle attempt

- Attempted at: `2026-07-27T04:43Z`
- Command target: kernel version 3, `submission.parquet`
- Result: skipped by Kaggle before submission creation
- Exact CLI result: `0 submissions remaining today.`
- Submission ref / status / score: N/A because Kaggle did not allocate a
  submission reference

This is a concrete external-cap skip, not a missing credential or missing
artifact: authenticated kernel upload completed, the kernel reached `COMPLETE`,
and the competition submit endpoint rejected the attempt because the shared
ARC-AGI-3 daily quota had already been consumed. The last recorded competition
submission at the time of the attempt was ref `54987255`, status `COMPLETE`,
public score `0.01`, created on 2026-07-26; it is not claimed as this GPT
champion's result.

## Gate conclusion

No new candidate was introduced in SOT-2001. The incumbent already passed the
recorded screen→independent-confirm promotion gate, so there is no rejected
candidate code to revert. The registry now identifies the exec-verified
incumbent and its exact kernel artifact. A later run may submit version 3 after
the shared daily quota resets without rebuilding or changing champion identity.
