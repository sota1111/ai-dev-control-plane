#!/usr/bin/env python3
"""Evaluate the fixed SOT-2179 mixed-dimension structural candidates.

The implementations intentionally prefer identity fallback over guessing.  A
candidate activates only when one structural hypothesis reproduces every
training pair and produces an unambiguous transformation for every test input.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from itertools import permutations
from pathlib import Path
from typing import Callable


Grid = list[list[int]]
Candidate = Callable[[dict], tuple[str, list[Grid]]]


def _identity(task: dict) -> tuple[str, list[Grid]]:
    return "fallback", [case["input"] for case in task["test"]]


def _separator_partitions(grid: Grid) -> list[tuple[int, list[Grid]]]:
    """Return unique full-line separator partitions with intact panels."""
    height, width = len(grid), len(grid[0])
    proposals: list[tuple[int, list[Grid]]] = []
    for colour in set(value for row in grid for value in row):
        separator_rows = [r for r, row in enumerate(grid) if set(row) == {colour}]
        separator_cols = [
            c for c in range(width) if {grid[r][c] for r in range(height)} == {colour}
        ]
        if bool(separator_rows) == bool(separator_cols):
            continue
        cuts = separator_rows if separator_rows else separator_cols
        limit = height if separator_rows else width
        bounds = [-1, *cuts, limit]
        panels: list[Grid] = []
        valid = True
        for start, end in zip(bounds, bounds[1:]):
            if end == start + 1:
                valid = False
                break
            if separator_rows:
                panels.append([row[:] for row in grid[start + 1 : end]])
            else:
                panels.append([row[start + 1 : end] for row in grid])
        if valid and len(panels) > 1:
            proposals.append((colour, panels))
    return proposals


def _join_panels(panels: list[Grid], colour: int, axis: str) -> Grid | None:
    if axis == "vertical":
        if len({len(row) for panel in panels for row in panel}) != 1:
            return None
        width = len(panels[0][0])
        separator = [[colour] * width]
        output: Grid = []
        for index, panel in enumerate(panels):
            if index:
                output.extend(separator)
            output.extend([row[:] for row in panel])
        return output
    if len({len(panel) for panel in panels}) != 1:
        return None
    output = []
    for row in range(len(panels[0])):
        joined: list[int] = []
        for index, panel in enumerate(panels):
            if index:
                joined.append(colour)
            joined.extend(panel[row])
        output.append(joined)
    return output


def _panel_hypotheses(input_grid: Grid, output_grid: Grid | None = None) -> list[tuple]:
    hypotheses = []
    for colour, panels in _separator_partitions(input_grid):
        if len(panels) > 6:
            continue
        for order in permutations(range(len(panels))):
            ordered = [panels[index] for index in order]
            for axis in ("vertical", "horizontal"):
                proposal = _join_panels(ordered, colour, axis)
                if proposal is not None and (output_grid is None or proposal == output_grid):
                    hypotheses.append((colour, order, axis, proposal))
    return hypotheses


def separator_guided_panel_reflow(task: dict) -> tuple[str, list[Grid]]:
    fitted: set[tuple] | None = None
    for pair in task["train"]:
        keys = {
            (colour, order, axis)
            for colour, order, axis, _ in _panel_hypotheses(
                pair["input"], pair["output"]
            )
        }
        fitted = keys if fitted is None else fitted & keys
    if not fitted or len(fitted) != 1:
        return _identity(task)
    colour, order, axis = next(iter(fitted))
    predictions = []
    for case in task["test"]:
        matches = [
            proposal
            for found_colour, found_order, found_axis, proposal in _panel_hypotheses(
                case["input"]
            )
            if (found_colour, found_order, found_axis) == (colour, order, axis)
        ]
        if len(matches) != 1:
            return _identity(task)
        predictions.append(matches[0])
    return "activated", predictions


def marker_guided_object_assembly(task: dict) -> tuple[str, list[Grid]]:
    """Conservative v1 guard.

    Rigid marker assembly is rejected unless a unique generic placement rule
    can be inferred.  The fixed fixtures admit several training-consistent
    marker/scaffold interpretations, so v1 deliberately falls back rather than
    embedding task IDs or expected test outputs.
    """
    return _identity(task)


CANDIDATES: dict[str, Candidate] = {
    "separator-guided-panel-reflow-v1": separator_guided_panel_reflow,
    "marker-guided-object-assembly-v1": marker_guided_object_assembly,
}


def _exact(predictions: list[Grid], task: dict) -> bool:
    return all(
        prediction == example.get("output")
        for prediction, example in zip(predictions, task["test"])
    )


def _evaluate(
    candidate_id: str,
    solver: Candidate,
    task_ids: list[str],
    positives: set[str],
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
                any(
                    hypothesis[3] == pair["output"]
                    for hypothesis in _panel_hypotheses(pair["input"])
                )
                for pair in task["train"]
            ) if candidate_id == "separator-guided-panel-reflow-v1" else status == "fallback"
        except Exception as error:
            faults += 1
            status, candidate_exact, identity_exact, train_consistent = (
                "fault", False, False, False
            )
            error_text = f"{type(error).__name__}: {error}"
        result = {
            "task": task_id,
            "expected_positive": task_id in positives,
            "status": status,
            "train_consistent": train_consistent,
            "identity_exact": identity_exact,
            "candidate_exact": candidate_exact,
        }
        if status == "fault":
            result["error"] = error_text
        results.append(result)
    positive_exact = sum(
        row["candidate_exact"] for row in results if row["expected_positive"]
    )
    false_activations = sum(
        row["status"] == "activated" for row in results if not row["expected_positive"]
    )
    regressions = sum(row["identity_exact"] and not row["candidate_exact"] for row in results)
    candidate_exact = sum(row["candidate_exact"] for row in results)
    identity_exact = sum(row["identity_exact"] for row in results)
    passed = (
        faults == 0
        and positive_exact >= 1
        and false_activations == 0
        and regressions == 0
        and candidate_exact > identity_exact
        and all(row["train_consistent"] for row in results)
    )
    return {
        "candidate": candidate_id,
        "task_ids": task_ids,
        "identity_exact_matches": identity_exact,
        "candidate_exact_matches": candidate_exact,
        "positive_exact_matches": positive_exact,
        "false_activations": false_activations,
        "fallbacks": sum(row["status"] == "fallback" for row in results),
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
        "issue": "SOT-2180",
        "spec_issue": spec["issue"],
        "dataset": spec["dataset"],
        "fixture_hashes": hashes,
        "incumbent": "identity",
        "protocol": "screen-then-independent-confirm",
        "candidates": [],
    }
    for candidate in spec["candidates"]:
        candidate_id = candidate["id"]
        positives = set(candidate["positive_tasks"])
        screen = _evaluate(
            candidate_id, CANDIDATES[candidate_id], spec["cohorts"]["screen"],
            positives, args.dataset
        )
        record = {"id": candidate_id, "screen": screen}
        if screen["passed"]:
            record["confirm"] = _evaluate(
                candidate_id, CANDIDATES[candidate_id],
                spec["cohorts"]["confirm"], positives, args.dataset
            )
        else:
            record["confirm"] = {
                "status": "not_run",
                "reason": "Candidate did not pass the pre-registered screen gate.",
            }
        record["decision"] = (
            "accept" if screen["passed"] and record["confirm"].get("passed") else "reject"
        )
        evidence["candidates"].append(record)
    accepted = [row["id"] for row in evidence["candidates"] if row["decision"] == "accept"]
    evidence["decision"] = "promote" if accepted else "reject"
    evidence["accepted_candidates"] = accepted
    evidence["behavior_changes_reverted"] = not accepted
    evidence["registry_champion_after"] = "identity" if not accepted else None
    args.output.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps({"decision": evidence["decision"], "accepted": accepted}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
