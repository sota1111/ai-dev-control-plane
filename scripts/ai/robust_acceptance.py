#!/usr/bin/env python3
"""Leave-largest-contribution-out robust acceptance test (SOT-2515 / playbook P3).

Purpose
-------
Tail-heavy metrics (pooled RMSE / SSE / log-loss) are dominated by a few
entities. A "treat" model can look better than "base" only because a handful of
lucky wells / users / series carry the whole delta. Promoting such a change is
how ROGII overfit public (public bronze 6.395 -> private 9.285). The 2nd-place
solution instead used a *leave-largest-contribution-out* test: remove the
entities that contribute most to the improvement and see how many must go before
the improvement disappears. If that count (k*) is smaller than the public
leaderboard size, the improvement is fragile luck -> reject.

Contract
--------
Inputs are two per-entity loss CSVs with header ``entity,loss`` (one row per
entity; ``loss`` is that entity's pooled contribution to the metric, e.g. its
SSE). ``base`` is the incumbent, ``treat`` the candidate.

For each entity ``w`` we compute the per-entity metric delta::

    g_w = loss_treat(w) - loss_base(w)

For a lower-is-better metric the total improvement is present iff
``sum(g_w) < 0``. We then remove entities in order of their *contribution to the
improvement* (largest favorable contribution first) and count k* = the number of
removals after which the net improvement vanishes. This refines the playbook's
"|g_w| descending" wording: for a genuine improvement the largest favorable
contributors are exactly the largest ``|g_w|`` entities, but ordering by
favorable contribution keeps the erosion curve monotonic and k* well-defined
even when some entities regressed.

Judgement (only when ``--public-size N`` is given):

    accept  iff  the change improves AND k* > N        -> exit 0
    reject  otherwise (no improvement, or k* <= N)      -> exit 1

Without ``--public-size`` the tool only reports (exit 0). Data / usage errors
exit 2.

Output: machine-readable JSON on stdout; a human-readable summary on stderr.
``--out PATH`` additionally writes the JSON to a file.

Design constraints: deterministic, standard library only (csv/math/json/argparse
— no numpy), and exec-compatible (no reliance on ``__file__`` or cwd; callable
from a target repo by absolute path).
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys

EXIT_ACCEPT = 0
EXIT_REJECT = 1
EXIT_ERROR = 2


class DataError(Exception):
    """Raised for malformed / inconsistent input CSVs."""


def _read_losses(path):
    """Read an ``entity,loss`` CSV into an ordered dict {entity: loss}.

    A header row named ``entity,loss`` (case-insensitive) is optional. Blank
    lines are skipped. Raises DataError on non-numeric loss, missing columns,
    or duplicate entities.
    """
    losses = {}
    try:
        handle = open(path, "r", newline="", encoding="utf-8")
    except OSError as exc:  # pragma: no cover - surfaced as DataError
        raise DataError("cannot open {}: {}".format(path, exc))
    with handle:
        reader = csv.reader(handle)
        for lineno, row in enumerate(reader, start=1):
            if not row or all(cell.strip() == "" for cell in row):
                continue
            if len(row) < 2:
                raise DataError(
                    "{}:{}: expected 'entity,loss', got {!r}".format(path, lineno, row)
                )
            entity = row[0].strip()
            raw = row[1].strip()
            if lineno == 1 and entity.lower() == "entity" and raw.lower() == "loss":
                continue  # header
            if entity == "":
                raise DataError("{}:{}: empty entity name".format(path, lineno))
            try:
                value = float(raw)
            except ValueError:
                raise DataError(
                    "{}:{}: non-numeric loss {!r} for entity {!r}".format(
                        path, lineno, raw, entity
                    )
                )
            if entity in losses:
                raise DataError("{}:{}: duplicate entity {!r}".format(path, lineno, entity))
            losses[entity] = value
    if not losses:
        raise DataError("{}: no data rows".format(path))
    return losses


def compute(base, treat, higher_better=False):
    """Compute the robust-acceptance result for two per-entity loss maps.

    Returns a plain dict (JSON-serialisable). ``base`` and ``treat`` are
    ``{entity: loss}``. Raises DataError if their entity sets differ.
    """
    base_entities = set(base)
    treat_entities = set(treat)
    if base_entities != treat_entities:
        missing_in_treat = sorted(base_entities - treat_entities)
        missing_in_base = sorted(treat_entities - base_entities)
        raise DataError(
            "entity sets differ (missing in treat: {}; missing in base: {})".format(
                missing_in_treat or "none", missing_in_base or "none"
            )
        )

    # Per-entity metric delta g_w = loss_treat - loss_base (lower is better by
    # default). favorable = how much this entity pushes the metric in the
    # improving direction (positive = supports the improvement).
    def favorable(g):
        return g if higher_better else -g

    entities = []
    for name in base:
        g = treat[name] - base[name]
        entities.append((name, g))

    base_total = math.fsum(base[name] for name in base)
    treat_total = math.fsum(treat[name] for name in treat)
    delta_total = math.fsum(g for _, g in entities)

    if higher_better:
        improved = delta_total > 0
    else:
        improved = delta_total < 0

    # Order by favorable contribution descending; deterministic tie-break on the
    # entity name. Removing the top favorable contributors erodes the
    # improvement as fast as possible.
    order = sorted(entities, key=lambda item: (-favorable(item[1]), item[0]))

    def still_improved(delta):
        return (delta > 0) if higher_better else (delta < 0)

    removal_curve = []
    remaining = delta_total
    k_star = 0
    found_k = not improved  # if not improved, k* stays 0
    for idx, (name, g) in enumerate(order, start=1):
        # Only removing favorable contributors can erode the improvement; once
        # we reach non-favorable entities the improvement can no longer vanish
        # by further removal, so stop extending the curve.
        if favorable(g) <= 0:
            break
        remaining -= g
        improved_now = still_improved(remaining)
        removal_curve.append(
            {
                "removed": idx,
                "entity": name,
                "g": g,
                "delta_remaining": remaining,
                "still_improved": improved_now,
            }
        )
        if not found_k and not improved_now:
            k_star = idx
            found_k = True
            break

    return {
        "n_entities": len(entities),
        "direction": "higher_better" if higher_better else "lower_better",
        "base_total": base_total,
        "treat_total": treat_total,
        "delta_total": delta_total,
        "improved": improved,
        "k_star": k_star,
        "removal_curve": removal_curve,
    }


def judge(result, public_size):
    """Attach a judgement given a public leaderboard size. Returns exit code."""
    if public_size is None:
        result["public_size"] = None
        result["judgement"] = "report_only"
        return EXIT_ACCEPT
    result["public_size"] = public_size
    accept = bool(result["improved"]) and result["k_star"] > public_size
    result["judgement"] = "accept" if accept else "reject"
    return EXIT_ACCEPT if accept else EXIT_REJECT


def _summary(result):
    lines = []
    lines.append(
        "robust-acceptance: {} entities, direction={}".format(
            result["n_entities"], result["direction"]
        )
    )
    lines.append(
        "  base_total={:.6g}  treat_total={:.6g}  delta_total={:.6g}  improved={}".format(
            result["base_total"],
            result["treat_total"],
            result["delta_total"],
            result["improved"],
        )
    )
    lines.append("  k* (leave-largest-contribution-out) = {}".format(result["k_star"]))
    if result.get("public_size") is not None:
        lines.append(
            "  public_size={}  ->  judgement={} (accept iff k* > public_size)".format(
                result["public_size"], result["judgement"]
            )
        )
    if result["removal_curve"]:
        lines.append("  removal curve (entity : delta_remaining : still_improved):")
        for point in result["removal_curve"]:
            lines.append(
                "    #{} {} : {:.6g} : {}".format(
                    point["removed"],
                    point["entity"],
                    point["delta_remaining"],
                    point["still_improved"],
                )
            )
    return "\n".join(lines)


def run(argv=None):
    parser = argparse.ArgumentParser(
        description="Leave-largest-contribution-out robust acceptance test (SOT-2515)."
    )
    parser.add_argument("--base", required=True, help="per-entity loss CSV for the incumbent")
    parser.add_argument("--treat", required=True, help="per-entity loss CSV for the candidate")
    parser.add_argument(
        "--public-size",
        type=int,
        default=None,
        help="public leaderboard size N; accept iff k* > N (else reject via exit code)",
    )
    parser.add_argument(
        "--higher-better",
        action="store_true",
        help="metric is higher-is-better (default: lower-is-better, e.g. RMSE/SSE)",
    )
    parser.add_argument("--out", default=None, help="also write the JSON result to this path")
    args = parser.parse_args(argv)

    if args.public_size is not None and args.public_size < 0:
        parser.error("--public-size must be >= 0")

    try:
        base = _read_losses(args.base)
        treat = _read_losses(args.treat)
        result = compute(base, treat, higher_better=args.higher_better)
    except DataError as exc:
        sys.stderr.write("error: {}\n".format(exc))
        return EXIT_ERROR

    exit_code = judge(result, args.public_size)

    payload = json.dumps(result, sort_keys=True)
    sys.stdout.write(payload + "\n")
    sys.stderr.write(_summary(result) + "\n")
    if args.out:
        try:
            with open(args.out, "w", encoding="utf-8") as handle:
                handle.write(payload + "\n")
        except OSError as exc:
            sys.stderr.write("error: cannot write --out {}: {}\n".format(args.out, exc))
            return EXIT_ERROR
    return exit_code


if __name__ == "__main__":
    sys.exit(run())
