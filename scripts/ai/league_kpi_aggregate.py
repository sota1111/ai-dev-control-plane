#!/usr/bin/env python3
"""SOT-1896: aggregate cross-agent league pairings into a payoff matrix + per-agent pool CI.

Reads the per-pairing shard JSONs written by ptcg-agent-matsu/eval/battle_matsu_take_ume.py
(one pairing each, from `--seat0 A:deck --seat1 B:deck --json -`) and produces the league KPI:

  * payoff matrix    P[a][b] = a's win rate vs b (decided games only)
  * per-agent league KPI = aggregate win rate over the WHOLE opponent pool, with Wilson 95% CI.
    This CI-lower is the gate metric: a candidate is promoted only if its pool CI-lower exceeds
    the incumbent champion's pool CI-lower over the same pool (screen small-N → confirm large-N).

Writes <OUT_DIR>/report.json and <OUT_DIR>/payoff_matrix.md. Fault-accounted: any illegal
action / timeout / dead subprocess counts as a fault (never folded into a win).
"""
from __future__ import annotations

import json
import math
import os
import sys


def wilson_ci(wins: int, decided: int, z: float = 1.959963984540054) -> tuple[float, float]:
    if decided <= 0:
        return (0.0, 1.0)
    p = wins / decided
    d = 1.0 + z * z / decided
    center = (p + z * z / (2 * decided)) / d
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * decided)) / decided) / d
    return max(0.0, center - margin), min(1.0, center + margin)


def base(label: str) -> str:
    """`matsu:01` -> `matsu` (drop the deck suffix for the agent axis)."""
    return label.split(":", 1)[0]


def main(argv: list[str]) -> int:
    shard_paths = argv[1:]
    if not shard_paths:
        print("usage: league_kpi_aggregate.py SHARD.json ...", file=sys.stderr)
        return 2

    champions = os.environ.get("CHAMPIONS", "").split()
    out_dir = os.environ["OUT_DIR"]
    run_id = os.environ.get("RUN_ID", "baseline")
    deck = os.environ.get("DECK", "")
    n_per = int(os.environ.get("N", "0"))

    agents: list[str] = list(champions)
    # wins[a][b] = games a won vs b ; dec[a][b] = decided games a-vs-b
    wins: dict[str, dict[str, int]] = {}
    dec: dict[str, dict[str, int]] = {}
    faults: dict[str, int] = {}
    pairings: list[dict] = []

    def ensure(a: str) -> None:
        if a not in agents:
            agents.append(a)
        wins.setdefault(a, {})
        dec.setdefault(a, {})
        faults.setdefault(a, 0)

    for path in shard_paths:
        if not os.path.isfile(path):
            print(f"warning: missing shard {path}", file=sys.stderr)
            continue
        with open(path, encoding="utf-8") as fh:
            rep = json.load(fh)
        for pr in rep.get("pairings", []):
            a, b = base(pr["a"]), base(pr["b"])
            ensure(a)
            ensure(b)
            aw, bw = int(pr["a_wins"]), int(pr["b_wins"])
            decided = aw + bw
            wins[a][b] = wins[a].get(b, 0) + aw
            wins[b][a] = wins[b].get(a, 0) + bw
            dec[a][b] = dec[a].get(b, 0) + decided
            dec[b][a] = dec[b].get(a, 0) + decided
            fdict = pr.get("faults", {}) or {}
            faults[a] += int(fdict.get(pr["a"], 0))
            faults[b] += int(fdict.get(pr["b"], 0))
            pairings.append({
                "a": a, "b": b, "n": pr.get("n"), "decided": decided,
                "a_wins": aw, "b_wins": bw, "draws": pr.get("draws", 0),
                "unfinished": pr.get("unfinished", 0),
                "a_win_rate": round(aw / decided, 4) if decided else None,
                "faults": {a: int(fdict.get(pr["a"], 0)), b: int(fdict.get(pr["b"], 0))},
            })

    # Per-agent league KPI: aggregate over the whole opponent pool.
    standings = []
    for a in agents:
        tw = sum(wins.get(a, {}).values())
        td = sum(dec.get(a, {}).values())
        lo, hi = wilson_ci(tw, td)
        standings.append({
            "agent": a,
            "pool_wins": tw,
            "pool_decided": td,
            "pool_win_rate": round(tw / td, 4) if td else None,
            "pool_ci95": [round(lo, 4), round(hi, 4)],
            "faults": faults.get(a, 0),
        })
    standings.sort(key=lambda r: (r["pool_win_rate"] is not None, r["pool_win_rate"] or 0.0),
                   reverse=True)

    total_faults = sum(faults.values())
    report = {
        "issue": "SOT-1896",
        "run_id": run_id,
        "kpi": "cross-agent round-robin league (aggregate win rate over opponent pool, Wilson 95% CI)",
        "deck": deck,
        "deck_mode": "mirror (both seats same deck; isolates agent skill)",
        "n_per_pairing": n_per,
        "agents": agents,
        "payoff_matrix": {a: {b: (round(wins[a].get(b, 0) / dec[a].get(b, 0), 4)
                                  if dec.get(a, {}).get(b) else None)
                              for b in agents if b != a} for a in agents},
        "pairings": pairings,
        "standings": standings,
        "total_faults": total_faults,
        "note": ("engine has no seed API; results are statistical (Wilson CI), not bit-reproducible. "
                 "screen small-N here; promote only after a large-N confirm run."),
    }
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)

    # Markdown payoff matrix + standings.
    lines = [f"# League KPI baseline — run `{run_id}`", ""]
    lines.append(f"- KPI: cross-agent round-robin (総当たり), per-agent aggregate win rate over the pool (Wilson 95% CI)")
    lines.append(f"- Deck: `{deck}` (mirror mode — both seats same deck, isolates agent skill)")
    lines.append(f"- N per pairing: {n_per} (seat-alternating) — **screen-N**")
    lines.append(f"- Total faults: **{total_faults}**")
    lines.append("")
    lines.append("## Payoff matrix — row agent's win rate vs column agent (decided games)")
    lines.append("")
    header = "| vs | " + " | ".join(agents) + " |"
    sep = "| --- | " + " | ".join("---:" for _ in agents) + " |"
    lines += [header, sep]
    for a in agents:
        cells = []
        for b in agents:
            if b == a:
                cells.append("—")
            else:
                v = report["payoff_matrix"][a].get(b)
                cells.append("n/a" if v is None else f"{v:.3f}")
        lines.append(f"| **{a}** | " + " | ".join(cells) + " |")
    lines.append("")
    lines.append("## Per-agent league KPI (aggregate over pool)")
    lines.append("")
    lines.append("| rank | agent | pool win rate | Wilson 95% CI | decided | faults |")
    lines.append("| ---: | --- | ---: | :---: | ---: | ---: |")
    for i, s in enumerate(standings, 1):
        wr = "n/a" if s["pool_win_rate"] is None else f"{s['pool_win_rate']:.3f}"
        ci = f"[{s['pool_ci95'][0]:.3f}, {s['pool_ci95'][1]:.3f}]"
        lines.append(f"| {i} | {s['agent']} | {wr} | {ci} | {s['pool_decided']} | {s['faults']} |")
    lines.append("")
    with open(os.path.join(out_dir, "payoff_matrix.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))

    # Console summary.
    print(f"  total faults: {total_faults}")
    for i, s in enumerate(standings, 1):
        wr = "n/a" if s["pool_win_rate"] is None else f"{s['pool_win_rate']:.3f}"
        print(f"  {i}. {s['agent']}: pool_wr={wr} "
              f"CI[{s['pool_ci95'][0]:.3f},{s['pool_ci95'][1]:.3f}] "
              f"decided={s['pool_decided']} faults={s['faults']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
