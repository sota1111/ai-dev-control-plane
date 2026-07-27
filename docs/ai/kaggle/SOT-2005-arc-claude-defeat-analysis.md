# SOT-2005 ARC-AGI-2 Claude champion defeat analysis

## Fixed evidence

- Kaggle submission `55009090` completed on 2026-07-26 with public score
  **0.00**. The deployed kernel `sota1111/arc-agi-2-claude-champion` was
  `COMPLETE` and its log says it wrote 240 tasks.
- Dataset: `arcprize/ARC-AGI-2` commit
  `f3283f727488ad98fe575ea6a5ac981e4a188e49`, `data/evaluation`
  (120 tasks / 167 test cases).
- Solver: `sota1111/arc-agi-2-claude` commit
  `34dc2403bdc69e09c940df76fe729064cbe7ebcb`.
- The deployed kernel source and repository `main.py` are byte-identical:
  SHA-256 `03db77b53e16bba84d6283d75b91826f75a0cb0f9735b23a40b2d2ee1bd727ad`.
- Machine-readable task detail:
  [`SOT-2005-arc-claude-defeat-analysis.json`](./SOT-2005-arc-claude-defeat-analysis.json).

Reproduce the public-cohort analysis after checking out the pinned inputs:

```bash
python3 scripts/ai/analyze_arc_claude_champion.py \
  --dataset /tmp/ARC-AGI-2/data/evaluation \
  --solver /tmp/arc-agi-2-claude/main.py \
  --deployed-source /tmp/kernel/arc-agi-2-claude-champion.py \
  --deployed-output /tmp/kernel-output/submission.json \
  --sample-submission /tmp/kaggle/sample_submission.json \
  --dataset-commit f3283f727488ad98fe575ea6a5ac981e4a188e49 \
  --solver-commit 34dc2403bdc69e09c940df76fe729064cbe7ebcb \
  --kaggle-submission-ref 55009090 \
  --output /tmp/SOT-2005.json
diff -u docs/ai/kaggle/SOT-2005-arc-claude-defeat-analysis.json /tmp/SOT-2005.json
```

## Baseline and failure classes

The deployed solver reproduces **0/120 exact tasks**. None of the 120 tasks has
even one train-consistent program in the current portfolio, so every one of the
167 test cases receives identity for both attempts:

| Metric | Result |
| --- | ---: |
| Task-level exact | 0 / 120 |
| Train-supported tasks | 0 / 120 |
| Fallback tasks | 120 / 120 |
| `attempt_1` identity | 167 / 167 |
| Duplicate `attempt_1` / `attempt_2` | 167 / 167 |

The current DSL contains identity, rotations (90/180/270), horizontal/vertical
reflection, transpose/anti-transpose, non-zero crop, integer scale, tile,
global colour mapping (also after a geometric transform), and constant output.
Every axis has **0 train-consistent / 0 test-exact tasks** on the pinned
evaluation cohort. This does not contradict the repository fixtures: its unit
suite proves rotation and global-colour-map success on two synthetic tasks, and
the e2e fixture proves identity on 2/2 identity tasks. The failure is coverage
against real evaluation tasks, not execution of those implemented primitives.

The deterministic shape-level failure split is:

| Unsupported class | Tasks | Share |
| --- | ---: | ---: |
| Context-dependent recolour or same-shape content transform | 81 | 67.5% |
| Object selection or extraction | 27 | 22.5% |
| Mixed-dimension structural transform | 9 | 7.5% |
| Conditional expansion or composition | 3 | 2.5% |

These are prioritisation classes, not official ARC semantic labels. Per-task
assignments and transform counts are recorded in the JSON.

## Submission contract versus solver capability

No evidence supports a submission-contract failure:

- the kernel source exactly matches the intended champion source;
- the kernel completed and produced all 240 sample task IDs;
- every test entry has exactly `attempt_1` and `attempt_2`;
- task counts, test-case counts, grids, rectangularity, integer colours, and
  output JSON all pass the local contract validator;
- the same deployed code produces a valid document on the pinned evaluation
  tasks without faults.

Therefore the 0.00 result is best attributed to **solver capability**, not input
discovery, output schema, kernel execution, or attempt serialization. There is
still a submission-quality defect: after no program fits training, both
attempts are identical identity guesses. That wastes the second allowed attempt,
but it is downstream of the solver's 120/120 training-coverage failure and is
not a schema violation.

## Evidence-backed improvement order

1. Add **context-dependent cell/object selection plus recolouring**. It targets
   the largest unsupported class (81/120), whereas the existing colour mapping
   can only replace each source colour globally. Require exact explanation of
   all training pairs before activation.
2. Add **connected-component selection/extraction** as a separate candidate for
   the 27/120 smaller-output tasks. Keep it separate because its predicates and
   output-shape risk differ from recolouring.
3. Replace duplicate fallback attempts with two deterministic, structurally
   distinct hypotheses only after they are train-scored. This improves attempt
   diversity but must not be mistaken for solving the missing transformation
   language.

For each candidate, use a fixed small screen followed by all 120 tasks; require
zero faults, at least one new exact task, a strict win over this 0/120 baseline,
and no regression. Do not spend the first iteration reimplementing rotations or
global recolouring: those primitives work in synthetic fixtures but activate on
none of the real evaluation tasks.
