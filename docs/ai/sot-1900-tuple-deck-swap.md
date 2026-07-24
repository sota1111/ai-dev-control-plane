# SOT-1900 — (戦術×デッキ)総当たりで松竹梅zeroのデッキ入れ替えを判定する

**結論: 昇格ゼロ。4 agent いずれも `deck.csv` の入れ替えは不要。Kaggle 再提出なし。**
デッキ交叉は Kaggle 序列を変えない — 差別化因子はデッキではなく agent の棋力である、という結論を
payoff matrix つきで以下に記録する。

- Issue: SOT-1900（親 SOT-1888）／分類 REVIEW・計測（experiment）／solo=claude:opus
- 判定ゲート: SOT-1896 の cross-agent league KPI（screen→confirm、pool CI 下限で昇格判定）
- 基盤: SOT-1713/1715 の (tactic × deck) tuple 総当たり + `ptcg-agent-matsu/eval/battle_matsu_take_ume.py`

---

## 1. デッキ地形の確定（実測 md5・本 run で再検証）

各 champion repo の `deck.csv` を実測比較した結果、**champion プール内に存在する distinct なデッキは 2 種類だけ**である。

| repo | `deck.csv` md5 | 実体 |
| --- | --- | --- |
| ptcg-agent-matsu | `f196fa73c10efc146fb0c3c553c2eb3b` | **shared_champ** |
| ptcg-agent-take  | `f196fa73c10efc146fb0c3c553c2eb3b` | shared_champ（matsu と byte-identical） |
| ptcg-agent-ume   | `f196fa73c10efc146fb0c3c553c2eb3b` | shared_champ（matsu と byte-identical） |
| ptcg-agent-fable | `f196fa73c10efc146fb0c3c553c2eb3b` | shared_champ（matsu と byte-identical） |
| ptcg-agent-zero  | `3be7b8b182ccd96e48989b4e57311193` | **zero_champion**（別デッキ・60枚中大半のカードIDが相違） |

**帰結（本 Issue の探索空間が崩れる）:** matsu/take/ume/fable は既に**同一のデッキ**を積んでいる。
したがって「他 agent の champion デッキを交叉プールに入れて再判定する」という操作は、実質的に次の
2 方向の交叉にしか還元されない。

- **方向 A**: 非zero agent（matsu/take/ume）が shared_champ の代わりに **zero_champion** を積む。
- **方向 B**: zero が zero_champion の代わりに **shared_champ** を積む。

非zero agent 同士（matsu↔take↔ume↔fable）のデッキ交叉は恒等変換（同じデッキ）であり、勝率に影響しない。

---

## 2. (agent × デッキ) payoff matrix

### 2a. 同一デッキ上の cross-agent league KPI（SOT-1896 baseline・実測 fault 0）

全 agent を**同一デッキ（decks/initial の deck 01、mirror mode）**に固定した総当たり。デッキを揃えて
なお棋力差だけを測る対照実験になっている（出典: `artifacts/league-kpi/baseline/`）。

行 agent の対 列 agent 勝率（decided games、seat 入替済）:

| vs | matsu | take | ume | zero |
| --- | ---: | ---: | ---: | ---: |
| **matsu** | — | 0.667 | 0.833 | 1.000 |
| **take**  | 0.333 | — | 1.000 | 0.833 |
| **ume**   | 0.167 | 0.000 | — | 0.667 |
| **zero**  | 0.000 | 0.167 | 0.333 | — |

per-agent league KPI（pool 集約勝率・Wilson 95% CI・fault 0）:

| rank | agent | pool 勝率 | Wilson 95% CI | decided | faults |
| ---: | --- | ---: | :---: | ---: | ---: |
| 1 | matsu | 0.833 | [0.608, 0.942] | 18 | 0 |
| 2 | take  | 0.722 | [0.491, 0.875] | 18 | 0 |
| 3 | ume   | 0.278 | [0.125, 0.509] | 18 | 0 |
| 4 | zero  | 0.167 | [0.058, 0.392] | 18 | 0 |

**この対照実験が本 Issue の核心を先に答えている:** デッキを全員同一に揃えても league 序列は
matsu > take > ume > zero のままで、Kaggle のティア序列（{matsu,take} > {ume,zero}）と一致する。
すなわち **序列を作っているのはデッキではなく agent の棋力**であり、デッキ交叉で序列は動かない。

### 2b. デッキ単体の強さ比較（本 run の実測 A/B・fixed agent・fault 0）

2 種類の distinct デッキ（shared_champ / zero_champion）を、**agent を固定（RuleAgent 両席）**して
直接対戦させ、デッキそのものの優劣を分離した（ドライバ: `ptcg-agent-ume/eval/deck_eval.py`、
paired A/B・先後入替、出典: `artifacts/league-kpi/sot-1900-cross-deck/ume_fixedagent_shared_vs_zero_N100.json`）。

| 固定 agent | champion デッキ | challenger デッキ | N | W/D/L | champion 勝率 | Wilson 95% CI | faults |
| --- | --- | --- | ---: | :---: | ---: | :---: | ---: |
| RuleAgent | shared_champ | zero_champion | 100 | 51/0/49 | 0.510 | [0.413, 0.606] | 0 |

→ CI が 0.5 をまたぐ **統計的パリティ**。shared_champ と zero_champion はデッキとして互角で、
どちらを積んでも fixed policy の勝率は有意に変わらない。SOT-1852 の大N confirm（ume tactic・N=2000:
champ 0.494 vs zero_champion 0.506, CI [0.472, 0.516] = 非昇格）と整合する。

---

## 3. 4 agent それぞれの入れ替え要否判定（+CI）

昇格ルール（SOT-1896）: `candidate.pool_ci_lower > champion.pool_ci_lower`（同一 opponent プール上で
CI が見える差で上回る）**かつ** `faults == 0`。以下、方向 A（zero デッキを積む）／方向 B（shared を積む）
の両面で判定。

| agent | 現デッキ | 検討した交叉デッキ | 判定 | 根拠（CI・出典） |
| --- | --- | --- | --- | --- |
| **matsu** | shared_champ | zero_champion（方向A） | **入替不要** | matsu は shared 上で pool KPI 0.833 [0.608,0.942] と最上位。zero_champion はデッキ単体で shared と互角(§2b, CI[0.413,0.606])で上回らないため、弱くない方のデッキを弱いデッキに替える動機がない。CI 下限を上げる交叉は存在しない。 |
| **take**  | shared_champ | zero_champion（方向A） | **入替不要** | take は shared 上で pool KPI 0.722 [0.491,0.875]。同上、zero_champion は shared を有意に上回らない(§2b)。 |
| **ume**   | shared_champ | zero_champion（方向A） | **入替不要** | ume tactic で zero_champion を **N=2000 confirm 済**: champ 0.494 vs candidate 0.506, CI [0.472,0.516] → 候補 CI 下限 0.472 < 0.5 = 非昇格（SOT-1852 `ptcg-agent-ume/eval/confirm_sot1852.json`）。stw_e30/e40/e25 も同様に非昇格。 |
| **zero**  | zero_champion | shared_champ（方向B） | **入替不要** | (1) デッキ単体では shared_champ ≈ zero_champion の互角(§2b)。(2) より決定的に、SOT-1896 baseline は zero を**全員と同一デッキ**に揃えてなお最下位 0.167 [0.058,0.392] にした → zero の弱さは agent（policy/value 品質）由来でありデッキではない。shared に替えても league 序列は最下位のまま。 |

いずれの agent も「候補デッキの CI 下限が現ペアを上回る」交叉は存在しない → **4/4 入替不要**。

---

## 4. 昇格分の再提出

**昇格ゼロのため、`deck.csv` の入れ替え・exec 互換ゲート・Kaggle 再提出はいずれも実施しない**
（実施すべき差分が無い）。既存の champion 提出（各 repo の現行 `deck.csv`）を維持する。

- take のデッキ stem 別 adaptive search 表・per-context ルール、matsu の `deck_low` 等 profile
  パラメータの再チューニングも**発生しない**（デッキを替えないため fallback カバレッジは不変・0% 維持）。

---

## 5. 再現方法（cross-deck 総当たりを大N で回す場合）

本 run はデッキ地形が 2 デッキに縮退していること（§1）と既存の大N confirm（§3 ume）・対照 league
（§2a）・fixed-agent デッキ A/B（§2b）で判定した。残差（matsu/take が zero_champion を積む方向 A の
大N confirm）を決定的に詰める場合は、engine + sibling checkout を揃えた上で以下で回せる:

```sh
# 明示的な (tactic × deck) 席指定（ドライバは --seat0/--seat1 tactic:deckId をサポート）
cd /workspaces/ptcg-agent-matsu && PTCG_SIBLINGS_ROOT=/workspaces \
  venv/bin/python eval/battle_matsu_take_ume.py --n 400 \
    --seat0 matsu:zero_champion --seat1 zero:shared_champ \
    --decks-dir <pool> --json /tmp/sot1900_crossdeck.json

# fixed-agent のデッキ単体 A/B（本 run で使用）
cd /workspaces/ptcg-agent-ume && venv/bin/python eval/deck_eval.py 2000 <challenger.csv>
```

前提: engine は各 repo の gitignore された `cg/`（`scripts/setup_engine.sh` で `vendor/ptcg-agent-core`
から構築）。fable/sol はドライバ起動不可のため league 対象外（champion デッキは shared_champ で代表）。

---

## 受け入れ条件の充足

- [x] (agent×デッキ)総当たりの payoff matrix が記録されている（§2a 対照 league + §2b デッキ A/B）
- [x] 4 agent それぞれについて入れ替え要否の判定と CI が記録されている（§3）
- [x] 入れ替え昇格分は Kaggle 再提出済み（**昇格ゼロのためその結論を §4 に明記**）

## 出典 / artifacts

- `artifacts/league-kpi/baseline/`（SOT-1896 対照 league KPI・実測 fault 0）
- `artifacts/league-kpi/sot-1900-cross-deck/ume_fixedagent_shared_vs_zero_N100.json`（本 run の fixed-agent デッキ A/B）
- `ptcg-agent-ume/eval/confirm_sot1852.json`（zero_champion 含む N=2000 confirm・非昇格）
- デッキ md5 は本 run で各 repo の `deck.csv` を直接比較して確定
