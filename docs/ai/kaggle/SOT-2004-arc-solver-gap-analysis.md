# SOT-2004 ARC solver gap analysis

## Fixed inputs and reproduction

- Dataset: `arcprize/ARC-AGI-2` commit
  `f3283f727488ad98fe575ea6a5ac981e4a188e49`, cohort `data/evaluation`
  (120 tasks, filename order).
- Solver: `sota1111/arc-agi-2-gpt` commit
  `bbec2bfa03f87a711c2f3687b178aa5565956947`.
- Champion: `identity`; rejected candidate: `rule-based-v1`.
- Machine-readable result:
  [`SOT-2004-arc-solver-gap-analysis.json`](./SOT-2004-arc-solver-gap-analysis.json).

From a checkout of this repository:

```bash
git clone https://github.com/arcprize/ARC-AGI-2.git /tmp/arc-agi-2
git -C /tmp/arc-agi-2 checkout f3283f727488ad98fe575ea6a5ac981e4a188e49
git clone https://github.com/sota1111/arc-agi-2-gpt.git /tmp/arc-agi-2-gpt
git -C /tmp/arc-agi-2-gpt checkout bbec2bfa03f87a711c2f3687b178aa5565956947
python3 scripts/ai/analyze_arc_solver_gaps.py \
  --dataset /tmp/arc-agi-2/data/evaluation \
  --dataset-commit f3283f727488ad98fe575ea6a5ac981e4a188e49 \
  --solver-repo /tmp/arc-agi-2-gpt \
  --solver-commit bbec2bfa03f87a711c2f3687b178aa5565956947 \
  --output /tmp/SOT-2004.json
diff -u docs/ai/kaggle/SOT-2004-arc-solver-gap-analysis.json /tmp/SOT-2004.json
```

## Baseline and fallback breakdown

Both solvers score **0/120 task-level exact matches**. `rule-based-v1` finds no
train-consistent program on any task, so all **120/120** tasks take its identity
fallback. The zero is therefore not a test-time generalisation failure: the
portfolio already fails to express every task at training time.

The deterministic shape/content taxonomy below is a prioritisation aid, not an
official ARC semantic label. Every row has identity exact = 0, rule exact = 0,
train-consistent = 0, and fallback equal to its task count.

| Unsupported category | Tasks | Share |
| --- | ---: | ---: |
| Contextual recolor | 63 | 52.5% |
| Object selection or extraction | 27 | 22.5% |
| Pattern completion | 11 | 9.2% |
| Mixed-dimension structural transform | 9 | 7.5% |
| Spatial rearrangement | 7 | 5.8% |
| Conditional expansion or composition | 3 | 2.5% |

Classification uses only train-pair invariants: equal dimensions plus changed
colour/content is contextual recolor; strict non-zero growth is pattern
completion; equal histograms indicate spatial rearrangement; consistently
smaller/larger dimensions indicate extraction/expansion; the remainder is
mixed-dimension. Per-task assignments are in the JSON for audit and refinement.

## Non-overlapping priority

The existing DSL already covers identity, rotations, reflections, transpose,
non-zero bounding-box crop, scale, tile, global colour mapping, and constant
output. Reimplementing these axes cannot address the observed fallback because
none is train-consistent on this cohort.

The first SOT-2009 candidate should be **context-dependent recolouring of
selected cells/objects while preserving grid dimensions**, starting with the
fixed screen tasks listed under `contextual-recolor` in the JSON. It is the
largest unsupported group (63/120) and is distinct from the current global
one-to-one colour mapping. Keep the candidate minimal: infer a selection
predicate from training pairs, recolour only selected cells, and reject the
program unless it explains every training pair exactly. Do not combine crop,
scale, tile, or movement in the first candidate.

Object selection/extraction is second priority. It should be evaluated
separately because a component-selection crop is a different program and risk
unit from contextual recolouring.

## SOT-2009 screen → confirm gate

1. **Small screen:** fixed first 20 filename-sorted evaluation tasks (8 are
   contextual-recolor). Require zero faults, at least one task-level exact match,
   and a strict win over identity (identity = 0). A candidate must remain
   train-consistent on every task where it activates; otherwise it falls back
   without claiming support.
2. **Independent confirm:** all 120 evaluation tasks at the same pinned commits.
   Require zero faults, at least one exact match, a strict exact-match win over
   identity, and no regression on any task the prior portfolio solves.
3. Record exact matches, train-consistent activations, fallback count, and the
   per-category breakdown produced here. Do not promote based only on increased
   activation or training fit.

If the screen or confirm fails, revert behavioural changes and retain only the
analysis and rejection reason. If it passes, first prove that `main.py` remains
stdin-`exec` compatible with the existing unit gate, then package the same
solver for Kaggle and treat the Kaggle result as external evidence. Registry
promotion occurs only after those gates; this analysis makes no registry or
solver behaviour change.
