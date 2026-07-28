# SOT-2125 pattern completion screen → confirm decision

## Decision

Neither `periodic-line-extrapolation-v1` nor
`reference-symmetry-repair-v1` is promoted. Both candidates safely returned the
identity fallback for all six fixed screen tasks. The screen had zero faults,
false activations, and regressions, but neither candidate reproduced its
positive task exactly or strictly beat the identity incumbent.

The pre-registered protocol permits independent confirm only after a candidate
passes screen. Confirm was therefore not run. No production solver, registry,
champion, or Kaggle runtime was changed; the champion remains `identity`.

## Fixed inputs

- Candidate specification:
  `docs/ai/kaggle/SOT-2124-pattern-completion-spec.json`
- ARC-AGI-2 dataset commit:
  `f3283f727488ad98fe575ea6a5ac981e4a188e49`
- Screen cohort:
  `142ca369`, `16de56c4`, `35ab12c3`, `8b7bacbf`, `981571dc`,
  `dbff022c`
- Confirm cohort, held out and not run:
  `1ae2feb7`, `4c416de3`, `d59b0160`, `da515329`, `dfadab01`
- Machine-readable result:
  `docs/ai/kaggle/SOT-2125-pattern-completion-evaluation.json`

All 11 fixture SHA-256 values were checked before evaluation. A mismatch aborts
the evaluator rather than silently changing the cohort.

## Screen result

| Candidate | Candidate exact | Identity exact | Fallbacks | False activations | Regressions | Faults |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `periodic-line-extrapolation-v1` | 0/6 | 0/6 | 6 | 0 | 0 | 0 |
| `reference-symmetry-repair-v1` | 0/6 | 0/6 | 6 | 0 | 0 | 0 |

The minimal implementations require a unique hypothesis that reproduces every
training output before they may touch an unknown input. The fixed positives
need richer operators than the v1 hypotheses: the periodic task combines
multiple line encodings, while the reference task contains multiple damaged
regions that are not explained by one whole-grid reflection. Broadening either
operator after seeing the screen result would violate the fixed-candidate gate.

## Reproduction

With the pinned ARC-AGI-2 checkout:

```bash
python3 scripts/ai/test_evaluate_arc_pattern_completion.py
python3 scripts/ai/verify_arc_pattern_completion_spec.py \
  --dataset /tmp/ARC-AGI-2/data/evaluation \
  --spec docs/ai/kaggle/SOT-2124-pattern-completion-spec.json \
  --source docs/ai/kaggle/SOT-2004-arc-solver-gap-analysis.json
python3 scripts/ai/evaluate_arc_pattern_completion.py \
  --dataset /tmp/ARC-AGI-2/data/evaluation \
  --spec docs/ai/kaggle/SOT-2124-pattern-completion-spec.json \
  --output docs/ai/kaggle/SOT-2125-pattern-completion-evaluation.json
```

The evaluator enforces screen-before-confirm, cohort separation inherited from
the verified specification, training-only activation, identity fallback on
ambiguity, and fault preservation in the output evidence.
