#!/usr/bin/env python3
"""Verify the pinned SOT-2124 pattern-completion specification."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path


def load(path: Path):
    return json.loads(path.read_text())


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
        assert data["train"] and data["test"]
        for pair in data["train"]:
            assert len(pair["input"]) == len(pair["output"])
            assert len(pair["input"][0]) == len(pair["output"][0])
            before = sum(cell != 0 for row in pair["input"] for cell in row)
            after = sum(cell != 0 for row in pair["output"] for cell in row)
            assert after > before

    counts = Counter(task["subcategory"] for task in tasks)
    assert dict(counts) == spec["subcategory_counts"]

    screen = spec["cohorts"]["screen"]
    confirm = spec["cohorts"]["confirm"]
    assert set(screen).isdisjoint(confirm)
    assert set(screen) | set(confirm) == set(task_ids)
    assert all(task["screen_or_confirm"] in {"screen", "confirm"} for task in tasks)
    assert {
        task["task"]: task["screen_or_confirm"] for task in tasks
    } == {task: "screen" for task in screen} | {
        task: "confirm" for task in confirm
    }

    candidate_ids = {candidate["id"] for candidate in spec["candidates"]}
    for candidate in spec["candidates"]:
        positives = candidate["positive_tasks"]
        assert len(positives) == len(set(positives))
        assert set(positives) <= set(task_ids)
        assert set(positives) & set(screen)
        assert set(positives) & set(confirm)
        assert candidate["activation_guards"]
        assert candidate["reject_when"]
    assert all(
        task["candidate"] is None or task["candidate"] in candidate_ids
        for task in tasks
    )

    print(
        "SOT-2124 spec verified: "
        f"{len(tasks)} tasks, {len(counts)} subcategories, "
        f"{len(screen)} screen, {len(confirm)} confirm"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
