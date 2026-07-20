# PTCG reward contract

`src/lib/ptcgReward.ts` defines a versioned reward boundary that depends only on environment
observations, the selected action, and terminal outcome. It has no dependency on a learner, model, or
search backend.

`ComposedPtcgReward` resolves configured components from a registry, applies their weights, and emits
the same `ptcg-reward-evaluation/v1` schema for training, inference, and offline comparison. Use
`comparePtcgRewardConfigs` to evaluate sparse, shaped, rule-based, or learned component registrations
against the exact same deterministic fixture.
