#!/usr/bin/env python3
"""Evaluate the fixed SOT-2124 pattern-completion candidates.

The candidates are deliberately narrow.  They are fitted only from training
pairs, return identity when the fit is ambiguous, and are evaluated in the
pre-registered screen -> confirm order.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from copy import deepcopy
from pathlib import Path
from typing import Callable


Grid = list[list[int]]
Candidate = Callable[[dict], tuple[str, list[Grid]]]


def _periodic_line(line: list[int]) -> list[int] | None:
    proposals: set[tuple[int, ...]] = set()
    for colour in set(line) - {0}:
        positions = [index for index, value in enumerate(line) if value == colour]
        if len(positions) < 2:
            continue
        gaps = {right - left for left, right in zip(positions, positions[1:])}
        if len(gaps) != 1:
            continue
        period = gaps.pop()
        residue = positions[0] % period
        sources = [
            (index, value)
            for index, value in enumerate(line)
            if value != 0 and index % period == residue
        ]
        if not sources:
            continue
        fill = max(sources)[1]
        proposal = list(line)
        for index in range(residue, len(line), period):
            proposal[index] = fill
        proposals.add(tuple(proposal))
    if len(proposals) != 1:
        return None
    result = list(proposals.pop())
    return result if result != line else None


def _periodic_transform(grid: Grid, axis: str) -> Grid | None:
    output = deepcopy(grid)
    changed = False
    if axis == "row":
        for row_index, row in enumerate(grid):
            proposal = _periodic_line(row)
            if proposal is not None:
                output[row_index] = proposal
                changed = True
    else:
        for column in range(len(grid[0])):
            line = [row[column] for row in grid]
            proposal = _periodic_line(line)
            if proposal is not None:
                for row_index, value in enumerate(proposal):
                    output[row_index][column] = value
                changed = True
    return output if changed else None


def periodic_line_extrapolation(task: dict) -> tuple[str, list[Grid]]:
    axes: list[str] = []
    for axis in ("row", "column"):
        if all(
            _periodic_transform(example["input"], axis) == example["output"]
            for example in task["train"]
        ):
            axes.append(axis)
    if len(axes) != 1:
        return "fallback", [example["input"] for example in task["test"]]
    predictions = [_periodic_transform(example["input"], axes[0]) for example in task["test"]]
    if any(prediction is None for prediction in predictions):
        return "fallback", [example["input"] for example in task["test"]]
    return "activated", predictions  # type: ignore[return-value]


def _symmetry_repair(grid: Grid, symmetry: str) -> Grid | None:
    height, width = len(grid), len(grid[0])
    output = deepcopy(grid)
    changed = False
    for row in range(height):
        for column in range(width):
            if grid[row][column] != 0:
                continue
            if symmetry == "horizontal":
                source = (row, width - 1 - column)
            elif symmetry == "vertical":
                source = (height - 1 - row, column)
            elif symmetry == "rotate":
                source = (height - 1 - row, width - 1 - column)
            elif symmetry == "transpose" and height == width:
                source = (column, row)
            elif symmetry == "anti-transpose" and height == width:
                source = (width - 1 - column, height - 1 - row)
            else:
                continue
            value = grid[source[0]][source[1]]
            if value:
                output[row][column] = value
                changed = True
    return output if changed else None


def reference_symmetry_repair(task: dict) -> tuple[str, list[Grid]]:
    fits = []
    for symmetry in ("horizontal", "vertical", "rotate", "transpose", "anti-transpose"):
        if all(
            _symmetry_repair(example["input"], symmetry) == example["output"]
            for example in task["train"]
        ):
            fits.append(symmetry)
    if len(fits) != 1:
        return "fallback", [example["input"] for example in task["test"]]
    predictions = [_symmetry_repair(example["input"], fits[0]) for example in task["test"]]
    if any(prediction is None for prediction in predictions):
        return "fallback", [example["input"] for example in task["test"]]
    return "activated", predictions  # type: ignore[return-value]


CANDIDATES: dict[str, Candidate] = {
    "periodic-line-extrapolation-v1": periodic_line_extrapolation,
    "reference-symmetry-repair-v1": reference_symmetry_repair,
}


def _exact(predictions: list[Grid], task: dict) -> bool:
    return all(
        prediction == example.get("output")
        for prediction, example in zip(predictions, task["test"])
    )


def _evaluate_candidate(
    candidate_id: str,
    solver: Candidate,
    task_ids: list[str],
    positive: set[str],
    dataset: Path,
) -> dict:
    results = []
    faults = 0
    for task_id in task_ids:
        task = json.loads((dataset / f"{task_id}.json").read_text())
        try:
            status, predictions = solver(task)
            candidate_exact = _exact(predictions, task)
            identity_exact = _exact([case["input"] for case in task["test"]], task)
            train_consistent = status == "fallback" or all(
                solver({"train": task["train"], "test": [{"input": pair["input"]}]})[0]
                in {"activated", "fallback"}
                for pair in task["train"]
            )
        except Exception as error:  # evidence must retain faults instead of hiding them
            faults += 1
            status = "fault"
            candidate_exact = False
            identity_exact = False
            train_consistent = False
            error_text = f"{type(error).__name__}: {error}"
        result = {
            "task": task_id,
            "expected_positive": task_id in positive,
            "status": status,
            "train_consistent": train_consistent,
            "identity_exact": identity_exact,
            "candidate_exact": candidate_exact,
        }
        if status == "fault":
            result["error"] = error_text
        results.append(result)
    positive_exact = sum(
        result["candidate_exact"] for result in results if result["expected_positive"]
    )
    false_activations = sum(
        result["status"] == "activated"
        for result in results
        if not result["expected_positive"]
    )
    regressions = sum(
        result["identity_exact"] and not result["candidate_exact"] for result in results
    )
    candidate_exact = sum(result["candidate_exact"] for result in results)
    identity_exact = sum(result["identity_exact"] for result in results)
    passed = (
        faults == 0
        and positive_exact >= 1
        and false_activations == 0
        and regressions == 0
        and candidate_exact > identity_exact
        and all(result["train_consistent"] for result in results)
    )
    return {
        "candidate": candidate_id,
        "task_ids": task_ids,
        "identity_exact_matches": identity_exact,
        "candidate_exact_matches": candidate_exact,
        "positive_exact_matches": positive_exact,
        "false_activations": false_activations,
        "fallbacks": sum(result["status"] == "fallback" for result in results),
        "regressions": regressions,
        "faults": faults,
        "passed": passed,
        "results": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    spec = json.loads(args.spec.read_text())
    hashes = {}
    for entry in spec["tasks"]:
        path = args.dataset / f"{entry['task']}.json"
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != entry["sha256"]:
            raise SystemExit(f"{entry['task']}: fixture hash mismatch")
        hashes[entry["task"]] = digest

    evidence = {
        "schema_version": 1,
        "issue": "SOT-2125",
        "spec_issue": spec["issue"],
        "dataset": spec["dataset"],
        "fixture_hashes": hashes,
        "incumbent": "identity",
        "protocol": "screen-then-independent-confirm",
        "candidates": [],
    }
    for candidate in spec["candidates"]:
        candidate_id = candidate["id"]
        solver = CANDIDATES[candidate_id]
        positives = set(candidate["positive_tasks"])
        screen = _evaluate_candidate(
            candidate_id, solver, spec["cohorts"]["screen"], positives, args.dataset
        )
        record = {"id": candidate_id, "screen": screen}
        if screen["passed"]:
            record["confirm"] = _evaluate_candidate(
                candidate_id,
                solver,
                spec["cohorts"]["confirm"],
                positives,
                args.dataset,
            )
        else:
            record["confirm"] = {
                "status": "not_run",
                "reason": "Candidate did not pass the pre-registered screen gate.",
            }
        record["decision"] = (
            "accept"
            if screen["passed"] and record["confirm"].get("passed")
            else "reject"
        )
        evidence["candidates"].append(record)

    accepted = [
        candidate["id"]
        for candidate in evidence["candidates"]
        if candidate["decision"] == "accept"
    ]
    evidence["decision"] = "promote" if accepted else "reject"
    evidence["accepted_candidates"] = accepted
    evidence["behavior_changes_reverted"] = not accepted
    evidence["registry_champion_after"] = "identity" if not accepted else None
    args.output.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps({"decision": evidence["decision"], "accepted": accepted}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
