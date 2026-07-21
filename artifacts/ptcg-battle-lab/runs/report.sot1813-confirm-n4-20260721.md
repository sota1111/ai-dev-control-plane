# PTCG battle report — run sot1813-confirm-n4-20260721

- schema: `ptcg-analyze/v1` · generated: 2026-07-21T11:40:14.445Z
- shards: 30/30 completed · matches: 120 · decided: 120 · draws: 0 · faults: 0
- config: matches/shard=4 seed=20260721 deck-mode=own chunks=1 · min-sample=30

## 順位 (ranking)

**順位未確定** — 順位未確定（CI重複: fable↔take, take↔ume, ume↔matsu, matsu↔zero）— 暫定順: fable > take > ume > matsu > zero > sol

## Overall standings (raw records から再計算)

| # | agent | winRate | Wilson95% CI | W-L | decided | draws | faults | 平均手数 | 平均時間(ms) |
|---|-------|--------:|--------------|-----|--------:|------:|-------:|--------:|-------------:|
| 1 | 譚 fable | 65.0% | [0.495, 0.779] | 26-14 | 40 | 0 | 0 | — | — |
| 2 | 竹 take | 65.0% | [0.495, 0.779] | 26-14 | 40 | 0 | 0 | — | — |
| 3 | 梅 ume | 65.0% | [0.495, 0.779] | 26-14 | 40 | 0 | 0 | — | — |
| 4 | 松 matsu | 50.0% | [0.352, 0.648] | 20-20 | 40 | 0 | 0 | — | — |
| 5 | 零 zero | 47.5% | [0.329, 0.625] | 19-21 | 40 | 0 | 0 | — | — |
| 6 | 陽 sol | 7.5% | [0.026, 0.199] | 3-37 | 40 | 0 | 0 | — | — |

## 先後 (seat) breakdown

| agent | seat | winRate | Wilson95% CI | W-L | decided |
|-------|------|--------:|--------------|-----|--------:|
| 譚 fable | 先手 | 65.0% | [0.433, 0.819] | 13-7 | 20 |
| 譚 fable | 後手 | 65.0% | [0.433, 0.819] | 13-7 | 20 |
| 竹 take | 先手 | 65.0% | [0.433, 0.819] | 13-7 | 20 |
| 竹 take | 後手 | 65.0% | [0.433, 0.819] | 13-7 | 20 |
| 梅 ume | 先手 | 65.0% | [0.433, 0.819] | 13-7 | 20 |
| 梅 ume | 後手 | 65.0% | [0.433, 0.819] | 13-7 | 20 |
| 松 matsu | 先手 | 50.0% | [0.299, 0.701] | 10-10 | 20 |
| 松 matsu | 後手 | 50.0% | [0.299, 0.701] | 10-10 | 20 |
| 零 zero | 先手 | 45.0% | [0.258, 0.658] | 9-11 | 20 |
| 零 zero | 後手 | 50.0% | [0.299, 0.701] | 10-10 | 20 |
| 陽 sol | 先手 | 5.0% | [0.009, 0.236] | 1-19 | 20 |
| 陽 sol | 後手 | 10.0% | [0.028, 0.301] | 2-18 | 20 |

## Head-to-head (pair) breakdown

| pair | A winRate (vs B) | Wilson95% CI | A-B wins | decided | draws | faults |
|------|-----------------:|--------------|----------|--------:|------:|-------:|
| matsu vs take | 50.0% | [0.215, 0.785] | 4-4 | 8 | 0 | 0 |
| matsu vs ume | 12.5% | [0.022, 0.471] | 1-7 | 8 | 0 | 0 |
| matsu vs zero | 62.5% | [0.306, 0.863] | 5-3 | 8 | 0 | 0 |
| fable vs matsu | 50.0% | [0.215, 0.785] | 4-4 | 8 | 0 | 0 |
| matsu vs sol | 75.0% | [0.409, 0.929] | 6-2 | 8 | 0 | 0 |
| take vs ume | 50.0% | [0.215, 0.785] | 4-4 | 8 | 0 | 0 |
| take vs zero | 50.0% | [0.215, 0.785] | 4-4 | 8 | 0 | 0 |
| fable vs take | 25.0% | [0.071, 0.591] | 2-6 | 8 | 0 | 0 |
| sol vs take | 0.0% | [0.000, 0.324] | 0-8 | 8 | 0 | 0 |
| ume vs zero | 50.0% | [0.215, 0.785] | 4-4 | 8 | 0 | 0 |
| fable vs ume | 62.5% | [0.306, 0.863] | 5-3 | 8 | 0 | 0 |
| sol vs ume | 0.0% | [0.000, 0.324] | 0-8 | 8 | 0 | 0 |
| fable vs zero | 87.5% | [0.529, 0.978] | 7-1 | 8 | 0 | 0 |
| sol vs zero | 12.5% | [0.022, 0.471] | 1-7 | 8 | 0 | 0 |
| fable vs sol | 100.0% | [0.676, 1.000] | 8-0 | 8 | 0 | 0 |

## Deck breakdown (by deck hash)

| deck (sha256[:12]) | agents | winRate | Wilson95% CI | decided |
|--------------------|--------|--------:|--------------|--------:|
| `42068a180390` | fable, matsu, take, ume | 61.3% | [0.535, 0.685] | 160 |
| `e92d5717fd04` | sol, zero | 27.5% | [0.189, 0.381] | 80 |

## Combo standings (tactic × deck)

| # | tactic | deck | winRate | Wilson95% CI | W-L | decided | draws | faults | 平均手数 | 平均時間(ms) |
|---|--------|------|--------:|--------------|-----|--------:|------:|-------:|--------:|-------------:|
| 1 | 譚 fable | 42068a180390 | 65.0% | [0.495, 0.779] | 26-14 | 40 | 0 | 0 | — | — |
| 2 | 竹 take | 42068a180390 | 65.0% | [0.495, 0.779] | 26-14 | 40 | 0 | 0 | — | — |
| 3 | 梅 ume | 42068a180390 | 65.0% | [0.495, 0.779] | 26-14 | 40 | 0 | 0 | — | — |
| 4 | 松 matsu | 42068a180390 | 50.0% | [0.352, 0.648] | 20-20 | 40 | 0 | 0 | — | — |
| 5 | 零 zero | e92d5717fd04 | 47.5% | [0.329, 0.625] | 19-21 | 40 | 0 | 0 | — | — |
| 6 | 陽 sol | e92d5717fd04 | 7.5% | [0.026, 0.199] | 3-37 | 40 | 0 | 0 | — | — |

## Best combo

**未確定** — 未確定: 暫定首位 fable × deck 42068a180390（順位未確定（CI重複: fable↔take, take↔ume, ume↔matsu, matsu↔zero）— 暫定順: fable > take > ume > matsu > zero > sol）

## Mirror analysis (same tactic, different decks only)

- v2 tactic/deck metadataなし（legacy run）
## Warnings

- CI重複: fable ↔ take
- CI重複: take ↔ ume
- CI重複: ume ↔ matsu
- CI重複: matsu ↔ zero

## Inputs (pinned)

| agent | repo | commit[:12] | deckHash[:12] |
|-------|------|-------------|---------------|
| 松 matsu | ptcg-agent-matsu | `58ca1eb3efff` | `42068a180390` |
| 竹 take | ptcg-agent-take | `5d7eef8f050f` | `42068a180390` |
| 梅 ume | ptcg-agent-ume | `a20b32461a6b` | `42068a180390` |
| 零 zero | ptcg-agent-zero | `7cb77a2bdf4b` | `e92d5717fd04` |
| 譚 fable | ptcg-agent-fable | `34064b3d4e80` | `42068a180390` |
| 陽 sol | ptcg-agent-sol | `bf2087b9a749` | `e92d5717fd04` |
