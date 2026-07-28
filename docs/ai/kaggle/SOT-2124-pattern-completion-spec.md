# SOT-2124 ARC-AGI-2 pattern completion candidate specification

## Fixed evidence

- Dataset: `arcprize/ARC-AGI-2` commit
  `f3283f727488ad98fe575ea6a5ac981e4a188e49`, cohort
  `data/evaluation`.
- Source classification:
  [`SOT-2004-arc-solver-gap-analysis.json`](./SOT-2004-arc-solver-gap-analysis.json).
  Its deterministic coarse classifier assigned 11/120 tasks to
  `pattern-completion` because every training pair keeps its dimensions and
  strictly increases its non-zero cell count.
- Solver reference: `sota1111/arc-agi-2-gpt` commit
  `bbec2bfa03f87a711c2f3687b178aa5565956947`.
- Machine-readable specification:
  [`SOT-2124-pattern-completion-spec.json`](./SOT-2124-pattern-completion-spec.json).

The `pattern-completion` label is a prioritisation bucket, not one semantic
operator. The pinned files' SHA-256 values in the JSON prevent a later dataset
revision from silently changing this decision.

## Reproducible subcategories

| Subcategory | Count | Task IDs | Disposition |
| --- | ---: | --- | --- |
| Multi-ray continuation | 1 | `142ca369` | Reject for v1: several geometry-specific rays |
| Periodic line extrapolation | 2 | `16de56c4`, `1ae2feb7` | Candidate 1 |
| Implied path or shape completion | 3 | `35ab12c3`, `4c416de3`, `8b7bacbf` | Reject for v1: no single local operator |
| Reference-symmetry repair | 2 | `981571dc`, `d59b0160` | Candidate 2 |
| Recursive spiral completion | 1 | `da515329` | Reject for v1: special recursive generator |
| Template hole fill | 1 | `dbff022c` | Reject for v1: overlaps selection/recolour |
| Symbolic stamp expansion | 1 | `dfadab01` | Reject for v1: learned multi-cell rewrite |

Each assignment is derived from the transformation visible in every training
pair, not from test outputs. `scripts/ai/verify_arc_pattern_completion_spec.py`
checks the pinned hashes, membership, category counts, cohort separation, and
candidate coverage.

## Candidate 1: periodic line extrapolation v1

Infer the shortest unique one-dimensional period from a non-background prefix
on exactly one axis, then repeat it only into the continuation region. The
candidate targets `16de56c4` in screen and `1ae2feb7` in confirm.

Activation is permitted only when one axis, one period, and one continuation
boundary reproduce every training output exactly while preserving all
pre-existing non-background cells. Reject if another period or axis also fits,
if a required output is not produced by the motif, or if continuation would
overwrite a contradictory cell.

This is not the current DSL's whole-grid `tile`: grid dimensions do not change
and only a training-inferred line continuation is emitted. It is also not
contextual recolour or object extraction because it creates a periodic spatial
sequence without selecting cells for colour replacement or changing the output
frame.

## Candidate 2: reference-symmetry repair v1

Find one unique intact repeated/reflected reference region and copy only its
mapped cells into the corresponding damaged region. The candidate targets
`981571dc` in screen and `d59b0160` in confirm.

Activation is permitted only when the same structural mapping identifies every
changed cell across all training pairs, preserves every unchanged cell, and
reproduces every training output exactly. Reject ambiguous mappings, cells with
no intact counterpart, or a mapping that changes anything outside the uniquely
identified damage region.

This is structural copy/repair, not the prior contextual-recolour axis: it
copies position-dependent values from an intact counterpart rather than
choosing cells or objects and assigning a colour. It does not crop or extract
an object.

## Fixed screen → independent confirm gate

The cohorts are task-disjoint and each contains one positive task for each
candidate plus negative tasks from other subcategories:

- Screen (6): `142ca369`, `16de56c4`, `35ab12c3`, `8b7bacbf`,
  `981571dc`, `dbff022c`.
- Confirm (5): `1ae2feb7`, `4c416de3`, `d59b0160`, `da515329`,
  `dfadab01`.

For each candidate separately, screen requires zero faults, exact agreement on
all training pairs whenever it activates, at least one exact positive task, a
strict win over identity, and zero activation on negative tasks. Confirm
repeats those requirements on the independent cohort and additionally requires
zero regression against the prior portfolio. Increased activation or training
fit alone is not a pass.

Passing both cohorts only nominates the candidate for the next-stage execution
gate. It does not modify the registry or champion.

## Next-stage decision contract

- If screen or confirm fails, revert solver behaviour and retain the analysis
  plus rejection reason in docs.
- If both pass, first prove stdin-`exec` compatibility, then package the same
  solver for Kaggle and require external evidence before registry/champion
  promotion.
- This issue changes neither
  `scripts/ai/kaggle_targets_registry.json` nor the champion implementation.

## Reproduction

With the dataset checked out at the pinned commit:

```bash
python3 scripts/ai/verify_arc_pattern_completion_spec.py \
  --dataset /tmp/ARC-AGI-2/data/evaluation \
  --spec docs/ai/kaggle/SOT-2124-pattern-completion-spec.json \
  --source docs/ai/kaggle/SOT-2004-arc-solver-gap-analysis.json
```
