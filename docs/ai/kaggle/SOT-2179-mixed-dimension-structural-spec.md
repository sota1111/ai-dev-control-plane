# SOT-2179 mixed-dimension structural candidate specification

## Fixed evidence

- Dataset: `arcprize/ARC-AGI-2` commit
  `f3283f727488ad98fe575ea6a5ac981e4a188e49`, cohort
  `data/evaluation`.
- Source classification:
  [`SOT-2004-arc-solver-gap-analysis.json`](./SOT-2004-arc-solver-gap-analysis.json).
  Its deterministic coarse classifier assigned 9/120 tasks to
  `mixed-dimension-structural-transform`.
- Solver reference: `sota1111/arc-agi-2-gpt` commit
  `bbec2bfa03f87a711c2f3687b178aa5565956947`.
- Machine-readable specification:
  [`SOT-2179-mixed-dimension-structural-spec.json`](./SOT-2179-mixed-dimension-structural-spec.json).

The source label is a remainder bucket, not a single semantic operator. The
pinned fixture SHA-256 values in the JSON prevent a later dataset revision from
silently changing the task set or this decision.

## Reproducible subcategories

| Subcategory | Count | Task IDs | Disposition |
| --- | ---: | --- | --- |
| Separator-guided panel reflow | 2 | `20270e3b`, `78332cb0` | Candidate 1 |
| Marker-guided scene assembly | 3 | `21897d95`, `4e34c42c`, `898e7135` | Candidate 2 for the two rigid-placement tasks; reject `21897d95`'s region rendering |
| Ordered object linearization | 2 | `291dc1e1`, `7b5033c1` | Reject: overlaps object selection/extraction |
| Symbolic stencil expansion | 2 | `65b59efc`, `f931b4a8` | Reject: learned substitution overlaps pattern completion |

Each assignment follows transformations visible in every training pair only.
The JSON records input/output dimensions and a concise invariant for each task.
`scripts/ai/verify_arc_mixed_dimension_spec.py` verifies pinned hashes, source
membership, dimensions, subcategory counts, cohort separation, and candidate
coverage.

## Candidate 1: separator-guided panel reflow v1

Detect exactly one full-span separator colour, split the grid into intact
rectangular panels, remove only the separator, then concatenate all panels on
the unique axis and in the unique order that reproduces every training output.
The screen positive is `20270e3b`; independent confirm is `78332cb0`.

Activation requires every output cell to trace to exactly one unchanged panel
cell and every panel to be consumed exactly once. Reject ambiguous partitions,
orders, or axes; incompatible panel shapes; padding, clipping, overlap,
recolouring, or invented cells; and any case reducible to a whole-grid
transpose, crop, scale, tile, or selection.

This differs from contextual recolour because payload values never change,
from extraction because no panel is discarded, and from pattern completion
because no motif cell is created.

## Candidate 2: marker-guided object assembly v1

Identify exactly one scaffold or connector relation, then rigidly place every
bounded payload object into one compact output using unique marker matches.
Preserve each object's orientation and internal pixels. The screen positive is
`4e34c42c`; independent confirm is `898e7135`.

Activation requires a unique placement for every payload, use of every payload
exactly once, and exact reproduction of every training output. Reject ambiguous
markers or scaffolds, missing placements, subset selection, pixel changes,
rotation/reflection/scaling, overlap precedence, or synthesis. `21897d95` is a
hard negative because it also renders/recolours regions rather than performing
rigid placement only.

This is structural assembly of all preserved objects, not selecting an object,
contextually recolouring cells, or extending a periodic pattern.

## Fixed screen → independent confirm gate

The task-disjoint cohorts each contain one positive for each candidate and
negatives from the rejected families:

- Screen (5): `20270e3b`, `4e34c42c`, `291dc1e1`, `65b59efc`,
  `7b5033c1`.
- Confirm (4): `78332cb0`, `898e7135`, `21897d95`, `f931b4a8`.

For each candidate separately, screen requires zero faults, exact agreement on
all training pairs whenever it activates, at least one exact positive task, a
strict win over identity, and zero negative activation. Confirm repeats these
requirements independently and additionally allows zero regression against the
prior portfolio. Increased activation or training fit alone is not a pass.

Passing both cohorts only nominates the candidate for the next execution gate.
This issue changes neither the solver, registry, nor champion.

## Next-stage decision contract

- If screen or confirm fails, revert solver behaviour and retain this
  specification plus the measured rejection reason.
- If both pass, prove stdin-`exec` compatibility, package the identical solver
  for Kaggle, and require external evidence before registry/champion promotion.
- Never promote from activation count or train consistency without independent
  task-level exact wins.

## Reproduction

With the dataset checked out at the pinned commit:

```bash
python3 scripts/ai/verify_arc_mixed_dimension_spec.py \
  --dataset /tmp/ARC-AGI-2/data/evaluation \
  --spec docs/ai/kaggle/SOT-2179-mixed-dimension-structural-spec.json \
  --source docs/ai/kaggle/SOT-2004-arc-solver-gap-analysis.json
```
