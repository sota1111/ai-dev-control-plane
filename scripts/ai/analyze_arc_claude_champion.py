#!/usr/bin/env python3
"""Reproduce the SOT-2005 Claude champion and submission-contract analysis."""

from __future__ import annotations

import argparse
import hashlib
import json
import runpy
from collections import Counter
from pathlib import Path


def rotate(grid):
    return [list(row) for row in zip(*grid[::-1])]


def transpose(grid):
    return [list(row) for row in zip(*grid)]


def flip_horizontal(grid):
    return [row[::-1] for row in grid]


def flip_vertical(grid):
    return grid[::-1]


def crop_nonzero(grid):
    cells = [
        (row, column)
        for row, values in enumerate(grid)
        for column, value in enumerate(values)
        if value != 0
    ]
    if not cells:
        return grid
    rows, columns = zip(*cells)
    return [
        row[min(columns) : max(columns) + 1]
        for row in grid[min(rows) : max(rows) + 1]
    ]


def scale(grid, row_factor, column_factor):
    return [
        [value for value in row for _ in range(column_factor)]
        for row in grid
        for _ in range(row_factor)
    ]


def tile(grid, row_factor, column_factor):
    return [row * column_factor for _ in range(row_factor) for row in grid]


def colour_mapping(pairs, transform):
    mapping = {}
    for source, target in pairs:
        transformed = transform(source)
        if len(transformed) != len(target) or len(transformed[0]) != len(target[0]):
            return None
        for source_row, target_row in zip(transformed, target):
            for source_value, target_value in zip(source_row, target_row):
                previous = mapping.setdefault(source_value, target_value)
                if previous != target_value:
                    return None
    return mapping


def candidate_programs(task):
    pairs = [(example["input"], example["output"]) for example in task["train"]]
    candidates = [
        ("identity", lambda grid: grid),
        ("rotate-90", rotate),
        ("rotate-180", lambda grid: rotate(rotate(grid))),
        ("rotate-270", lambda grid: rotate(rotate(rotate(grid)))),
        ("flip-horizontal", flip_horizontal),
        ("flip-vertical", flip_vertical),
        ("transpose", transpose),
        ("anti-transpose", lambda grid: flip_horizontal(transpose(grid))),
        ("crop-nonzero", crop_nonzero),
    ]
    first_input, first_output = pairs[0]
    if (
        len(first_output) % len(first_input) == 0
        and len(first_output[0]) % len(first_input[0]) == 0
    ):
        row_factor = len(first_output) // len(first_input)
        column_factor = len(first_output[0]) // len(first_input[0])
        if row_factor > 1 or column_factor > 1:
            candidates.extend(
                (
                    (
                        "scale",
                        lambda grid, r=row_factor, c=column_factor: scale(grid, r, c),
                    ),
                    (
                        "tile",
                        lambda grid, r=row_factor, c=column_factor: tile(grid, r, c),
                    ),
                )
            )
    base_candidates = tuple(candidates)
    for name, transform in base_candidates:
        mapping = colour_mapping(pairs, transform)
        if mapping is not None:
            candidates.append(
                (
                    f"{name}+global-colour-map",
                    lambda grid, base=transform, colours=mapping: [
                        [colours.get(value, value) for value in row]
                        for row in base(grid)
                    ],
                )
            )
    if all(output == first_output for _, output in pairs):
        candidates.append(("constant-output", lambda _grid, output=first_output: output))
    return candidates


def train_consistent(task, program):
    try:
        return all(
            program(example["input"]) == example["output"]
            for example in task["train"]
        )
    except (IndexError, ValueError):
        return False


def test_exact(task, program):
    try:
        return all(
            program(example["input"]) == example["output"]
            for example in task["test"]
        )
    except (IndexError, ValueError):
        return False


def classify_failure(task):
    pairs = [(example["input"], example["output"]) for example in task["train"]]
    same_shape = all(
        (len(source), len(source[0])) == (len(target), len(target[0]))
        for source, target in pairs
    )
    if same_shape:
        changed = [
            (source_value, target_value)
            for source, target in pairs
            for source_row, target_row in zip(source, target)
            for source_value, target_value in zip(source_row, target_row)
            if source_value != target_value
        ]
        if changed:
            return "context-dependent-recolour-or-content-transform"
        return "identity"
    if all(
        len(target) <= len(source) and len(target[0]) <= len(source[0])
        for source, target in pairs
    ):
        return "object-selection-or-extraction"
    if all(
        len(target) >= len(source) and len(target[0]) >= len(source[0])
        for source, target in pairs
    ):
        return "conditional-expansion-or-composition"
    return "mixed-dimension-structural-transform"


def valid_grid(grid):
    return (
        isinstance(grid, list)
        and bool(grid)
        and all(isinstance(row, list) and bool(row) for row in grid)
        and len({len(row) for row in grid}) == 1
        and all(
            isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 9
            for row in grid
            for value in row
        )
    )


def validate_submission(submission, challenges):
    failures = []
    if set(submission) != set(challenges):
        failures.append("task-id-set")
    for task_id, task in challenges.items():
        attempts = submission.get(task_id)
        if not isinstance(attempts, list) or len(attempts) != len(task["test"]):
            failures.append(f"{task_id}:test-count")
            continue
        for index, entry in enumerate(attempts):
            if not isinstance(entry, dict) or set(entry) != {"attempt_1", "attempt_2"}:
                failures.append(f"{task_id}:{index}:attempt-keys")
                continue
            if not valid_grid(entry["attempt_1"]) or not valid_grid(entry["attempt_2"]):
                failures.append(f"{task_id}:{index}:grid")
    return failures


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--solver", type=Path, required=True)
    parser.add_argument("--deployed-source", type=Path, required=True)
    parser.add_argument("--deployed-output", type=Path, required=True)
    parser.add_argument("--sample-submission", type=Path, required=True)
    parser.add_argument("--dataset-commit", required=True)
    parser.add_argument("--solver-commit", required=True)
    parser.add_argument("--kaggle-submission-ref", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    tasks = {}
    for path in sorted(args.dataset.glob("*.json")):
        tasks[path.stem] = json.loads(path.read_text(encoding="utf-8"))
    challenges = {
        task_id: {
            "train": task["train"],
            "test": [{"input": example["input"]} for example in task["test"]],
        }
        for task_id, task in tasks.items()
    }

    namespace = runpy.run_path(str(args.deployed_source), run_name="sot_2005_analysis")
    submission = namespace["build_submission"](challenges)
    transform_metrics = {
        name: {"train_consistent": 0, "test_exact": 0}
        for name in (
            "identity",
            "rotate-90",
            "rotate-180",
            "rotate-270",
            "flip-horizontal",
            "flip-vertical",
            "transpose",
            "anti-transpose",
            "crop-nonzero",
            "scale",
            "tile",
            "global-colour-map",
            "constant-output",
        )
    }
    fallback_categories = Counter()
    details = []
    solved = 0
    train_supported = 0
    identity_attempts = 0
    duplicate_attempts = 0

    for task_id, task in tasks.items():
        supported = []
        exact = []
        for name, program in candidate_programs(task):
            if train_consistent(task, program):
                supported.append(name)
                metric = transform_metrics.setdefault(
                    name, {"train_consistent": 0, "test_exact": 0}
                )
                metric["train_consistent"] += 1
                if test_exact(task, program):
                    exact.append(name)
                    metric["test_exact"] += 1
                if name.endswith("+global-colour-map"):
                    transform_metrics["global-colour-map"]["train_consistent"] += 1
                    if test_exact(task, program):
                        transform_metrics["global-colour-map"]["test_exact"] += 1
        task_solved = all(
            any(
                entry[key] == expected["output"]
                for key in ("attempt_1", "attempt_2")
            )
            for entry, expected in zip(submission[task_id], task["test"])
        )
        solved += task_solved
        train_supported += bool(supported)
        for entry, test in zip(submission[task_id], task["test"]):
            identity_attempts += entry["attempt_1"] == test["input"]
            duplicate_attempts += entry["attempt_1"] == entry["attempt_2"]
        category = None if supported else classify_failure(task)
        if category:
            fallback_categories[category] += 1
        details.append(
            {
                "task": task_id,
                "train_consistent_programs": supported,
                "test_exact_programs": exact,
                "submission_exact": task_solved,
                "unsupported_category": category,
            }
        )

    deployed_output = json.loads(args.deployed_output.read_text(encoding="utf-8"))
    sample = json.loads(args.sample_submission.read_text(encoding="utf-8"))
    source_bytes = args.solver.read_bytes()
    deployed_bytes = args.deployed_source.read_bytes()
    total_tests = sum(len(task["test"]) for task in tasks.values())
    result = {
        "issue": "SOT-2005",
        "inputs": {
            "dataset_commit": args.dataset_commit,
            "dataset_cohort": "data/evaluation",
            "solver_commit": args.solver_commit,
            "kaggle_submission_ref": args.kaggle_submission_ref,
        },
        "baseline": {
            "tasks": len(tasks),
            "test_cases": total_tests,
            "submission_exact_tasks": solved,
            "train_supported_tasks": train_supported,
            "fallback_tasks": len(tasks) - train_supported,
            "identity_attempt_1_test_cases": identity_attempts,
            "duplicate_attempt_test_cases": duplicate_attempts,
        },
        "transform_metrics": dict(sorted(transform_metrics.items())),
        "unsupported_categories": dict(fallback_categories.most_common()),
        "submission_contract": {
            "local_evaluation_failures": validate_submission(submission, challenges),
            "deployed_output_failures": validate_submission(
                deployed_output,
                {
                    task_id: {"test": [{} for _ in attempts]}
                    for task_id, attempts in sample.items()
                },
            ),
            "sample_task_count": len(sample),
            "deployed_task_count": len(deployed_output),
            "solver_sha256": hashlib.sha256(source_bytes).hexdigest(),
            "deployed_source_sha256": hashlib.sha256(deployed_bytes).hexdigest(),
            "source_matches_deployed": source_bytes == deployed_bytes,
        },
        "tasks": details,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
