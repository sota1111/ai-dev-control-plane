# SOT-2180 mixed-dimension structural promotion decision

## Decision

Neither fixed candidate passed the pre-registered small screen, so independent
confirm was not run and no candidate is promoted. The registry and champion
remain `identity`; no production solver or Kaggle runtime changed.

The machine-readable evidence is
[`SOT-2180-mixed-dimension-evaluation.json`](./SOT-2180-mixed-dimension-evaluation.json).
It pins the nine fixture hashes and preserves the fixed screen-first protocol.

## Screen results

| Candidate | Faults | Positive exact | Negative activations | Fallbacks | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| `separator-guided-panel-reflow-v1` | 0 | 0 | 0 | 5/5 | Reject |
| `marker-guided-object-assembly-v1` | 0 | 0 | 0 | 5/5 | Reject |

The panel candidate searches only intact full-line separator partitions,
permutations, and horizontal/vertical concatenations. No unique hypothesis
reproduced the screen positive. The assembly candidate stays inactive because
the fixed examples admit multiple scaffold/marker interpretations; encoding
task IDs or expected evaluation outputs would violate the training-only
contract. Both candidates therefore took the required identity fallback with
zero faults and zero negative activation.

## Confirm and promotion

The fixed contract permits confirm only after a screen pass. Since both
candidates missed the required positive exact task and strict win over
identity, confirm is recorded as `not_run`. This is the required early-stop,
not missing evidence.

The non-promotion branch was applied:

- production solver behavior: unchanged;
- control-plane registry champion: `identity`;
- target repository registry/champion/runtime: unchanged;
- exec compatibility and submission-schema checks: not applicable because
  those are promotion-only gates.

## Reproduction

```bash
python3 scripts/ai/evaluate_arc_mixed_dimension.py \
  --dataset /tmp/ARC-AGI-2/data/evaluation \
  --spec docs/ai/kaggle/SOT-2179-mixed-dimension-structural-spec.json \
  --output docs/ai/kaggle/SOT-2180-mixed-dimension-evaluation.json
```
