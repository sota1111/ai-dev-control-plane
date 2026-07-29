#!/usr/bin/env python3
"""Verify the pinned SOT-2179 mixed-dimension structural specification."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path


def load(path: Path):
    return json.loads(path.read_text())


def dimensions(grid: list[list[int]]) -> str:
    return f"{len(grid)}x{len(grid[0])}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    args = parser.parse_args()

    spec = load(args.spec)
    source = load(args.source)
    tasks = spec["tasks"]
    task_ids = [task["task"] for task in tasks]
    source_ids = [
        task["task"]
        for task in source["tasks"]
        if task["category"] == spec["dataset"]["coarse_category"]
    ]

    assert spec["dataset"]["commit"] == source["dataset"]["commit"]
    assert len(task_ids) == len(set(task_ids)) == spec["dataset"]["task_count"]
    assert task_ids == source_ids

    for task in tasks:
        fixture = args.dataset / f"{task['task']}.json"
        assert fixture.is_file(), f"missing fixture: {fixture}"
        digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
        assert digest == task["sha256"], f"fixture hash changed: {task['task']}"
        data = load(fixture)
        assert len(data["train"]) == task["train_pairs"]
        actual_dimensions = [
            f"{dimensions(pair['input'])}->{dimensions(pair['output'])}"
            for pair in data["train"]
        ]
        assert actual_dimensions == task["dimension_pairs"]
        assert any(
            dimensions(pair["input"]) != dimensions(pair["output"])
            for pair in data["train"]
        )
        assert task["evidence"]

    counts = Counter(task["subcategory"] for task in tasks)
    assert dict(counts) == spec["subcategory_counts"]

    screen = spec["cohorts"]["screen"]
    confirm = spec["cohorts"]["confirm"]
    assert set(screen).isdisjoint(confirm)
    assert set(screen) | set(confirm) == set(task_ids)
    assert {
        task["task"]: task["screen_or_confirm"] for task in tasks
    } == {task: "screen" for task in screen} | {
        task: "confirm" for task in confirm
    }

    candidate_ids = {candidate["id"] for candidate in spec["candidates"]}
    assert len(candidate_ids) == len(spec["candidates"]) == 2
    for candidate in spec["candidates"]:
        positives = candidate["positive_tasks"]
        assert len(positives) == len(set(positives))
        assert set(positives) <= set(task_ids)
        assert set(positives) & set(screen)
        assert set(positives) & set(confirm)
        assert candidate["activation_guards"]
        assert candidate["reject_when"]
        assert candidate["non_overlap"]
    assert all(
        task["candidate"] is None or task["candidate"] in candidate_ids
        for task in tasks
    )
    assert {
        task["task"]
        for task in tasks
        if task["candidate"] is not None
    } == {
        task
        for candidate in spec["candidates"]
        for task in candidate["positive_tasks"]
    }

    gate = spec["promotion_gate"]
    for phase in ("screen", "confirm"):
        assert gate[phase]["faults"] == 0
        assert gate[phase]["train_consistency_on_activation"] == 1.0
        assert gate[phase]["minimum_positive_exact_tasks_per_candidate"] >= 1
        assert gate[phase]["minimum_strict_wins_over_identity"] >= 1
        assert gate[phase]["maximum_negative_task_activations"] == 0
    assert gate["confirm"]["maximum_regressions_against_prior_portfolio"] == 0
    assert spec["next_stage"]["registry_change_in_this_issue"] is False
    assert spec["next_stage"]["champion_change_in_this_issue"] is False

    print(
        "SOT-2179 spec verified: "
        f"{len(tasks)} tasks, {len(counts)} subcategories, "
        f"{len(screen)} screen, {len(confirm)} confirm, "
        f"{len(candidate_ids)} candidates"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
