#!/usr/bin/env python3
"""Reproduce the SOT-2004 ARC-AGI-2 solver gap analysis."""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from collections import Counter
from pathlib import Path


def dimensions(grid):
    return len(grid), len(grid[0])


def histogram(grid):
    return Counter(cell for row in grid for cell in row)


def nonzero_cells(grid) -> int:
    return sum(cell != 0 for row in grid for cell in row)


def classify_unsupported(task) -> str:
    pairs = [(example.input, example.output) for example in task.train]
    if all(dimensions(source) == dimensions(target) for source, target in pairs):
        if all(histogram(source) == histogram(target) for source, target in pairs):
            return "spatial-rearrangement"
        if all(nonzero_cells(target) > nonzero_cells(source) for source, target in pairs):
            return "pattern-completion"
        return "contextual-recolor"

    if all(
        dimensions(target)[0] <= dimensions(source)[0]
        and dimensions(target)[1] <= dimensions(source)[1]
        for source, target in pairs
    ):
        return "object-selection-or-extraction"
    if all(
        dimensions(target)[0] >= dimensions(source)[0]
        and dimensions(target)[1] >= dimensions(source)[1]
        for source, target in pairs
    ):
        return "conditional-expansion-or-composition"
    return "mixed-dimension-structural-transform"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--solver-repo", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dataset-commit", required=True)
    parser.add_argument("--solver-commit", required=True)
    args = parser.parse_args()

    sys.path.insert(0, str(args.solver_repo.resolve()))
    arcagi = importlib.import_module("arcagi")
    tasks = arcagi.load_tasks(args.dataset)
    identity = arcagi.IdentityAgent()
    rule_based = arcagi.RuleBasedAgent()

    categories = Counter()
    category_metrics: dict[str, Counter] = {}
    details = []
    identity_exact = 0
    rule_exact = 0
    fallback = 0
    train_consistent = 0

    for task in tasks:
        identity_score = arcagi.evaluate((task,), identity).scores[0]
        rule_score = arcagi.evaluate((task,), rule_based).scores[0]
        identity_train = all(pair.input == pair.output for pair in task.train)
        programs = rule_based._programs(task)  # Intentional analysis of the current portfolio.
        program_train = all(programs[0](pair.input) == pair.output for pair in task.train)
        used_fallback = not identity_train and not program_train

        if identity_score.passed:
            identity_exact += 1
        if rule_score.passed:
            rule_exact += 1
        if used_fallback:
            fallback += 1
        if program_train:
            train_consistent += 1

        if identity_train:
            category = "implemented-identity"
        elif program_train:
            category = "implemented-rule-dsl"
        else:
            category = classify_unsupported(task)
        categories[category] += 1
        metrics = category_metrics.setdefault(category, Counter())
        metrics["tasks"] += 1
        metrics["identity_exact"] += identity_score.passed
        metrics["rule_based_exact"] += rule_score.passed
        metrics["fallback"] += used_fallback
        metrics["train_consistent"] += program_train
        details.append(
            {
                "task": task.task_id,
                "category": category,
                "identity_exact": identity_score.passed,
                "rule_based_exact": rule_score.passed,
                "fallback": used_fallback,
                "train_consistent": program_train,
            }
        )

    result = {
        "issue": "SOT-2004",
        "dataset": {
            "repository": "https://github.com/arcprize/ARC-AGI-2",
            "commit": args.dataset_commit,
            "cohort": "data/evaluation",
            "tasks": len(tasks),
        },
        "solver": {
            "repository": "https://github.com/sota1111/arc-agi-2-gpt",
            "commit": args.solver_commit,
            "champion": "identity",
            "candidate": "rule-based-v1",
        },
        "baseline": {
            "identity_exact": identity_exact,
            "rule_based_exact": rule_exact,
            "rule_based_fallback": fallback,
            "rule_based_train_consistent": train_consistent,
        },
        "categories": {
            category: dict(category_metrics[category])
            for category, _count in categories.most_common()
        },
        "tasks": details,
        "next_gate": {
            "candidate": categories.most_common(1)[0][0],
            "screen": {
                "cohort": "first 20 lexicographically sorted evaluation tasks",
                "minimum_exact_matches": 1,
                "must_strictly_beat_identity": True,
                "faults": 0,
            },
            "confirm": {
                "cohort": "all 120 evaluation tasks",
                "minimum_exact_matches": 1,
                "must_strictly_beat_identity": True,
                "faults": 0,
            },
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
