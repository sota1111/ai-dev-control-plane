# 松 agent decision candidate promotion

`src/lib/ptcgDecisionPromotion.ts` is the promotion gate for replay-driven 松 policy candidates. It
keeps the candidate artifact, deck, tactic, four trace diagnoses, paired holdout statistics, severe
matchup deltas, failures, timeouts, and runtime in one versioned machine-readable verdict.

`choosePolicyAction` is the minimal candidate policy layer: it adjusts the champion's base action
scores only in a diagnosed scene. It favors a draw pivot over unsupported early multi-prize exposure,
an immediately actionable evolution over a stranded one, a lower next-reply prize liability, and
search/draw continuity after disruption. All other champion scoring remains unchanged.

The four mandatory regression scenes are `opening-board`, `evolution-window`, `prize-trade`, and
`disruption-recovery`. Each record links a stable replay reference to the observed failure, expected
action, minimal policy change, and regression result. Alakazam and Mega Lucario are recorded as named
matchups rather than being hidden in aggregate win rate.

A candidate is submission-eligible only when all of these hold:

- all four scene regressions pass;
- the paired candidate-minus-champion 95% confidence interval is wholly above zero;
- no recorded major matchup has a negative win-rate difference;
- candidate faults and timeouts do not exceed the champion counts;
- candidate mean runtime is at most 110% of champion runtime.

`evaluatePromotion` returns identical values for `promoted` and `submissionEligible`. A rejected
candidate remains auditable with explicit reasons, but cannot accidentally enter the Kaggle submission
set. The caller should serialize the returned verdict alongside the paired JSON/Markdown reports using
the same run/version id.
