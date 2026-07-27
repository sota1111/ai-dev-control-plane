"""Offline, exec-compatible Kaggle entry point for the ARC Prize 2026.

The current champion recorded by ``registry.json`` is the identity solver.  This
file intentionally contains the complete submission runtime so Kaggle can exec
it without a package install, a stable working directory, or module-path globals.
"""

import glob
import json
import os


DEFAULT_CHALLENGE_PATHS = (
    "/kaggle/input/arc-prize-2026/arc-agi_test_challenges.json",
    "/kaggle/input/arc-prize-2026/arc-agi_test_challenges/arc-agi_test_challenges.json",
)
DEFAULT_OUTPUT_PATH = "/kaggle/working/submission.json"


def _challenge_path():
    override = os.environ.get("ARC_CHALLENGES_PATH")
    if override:
        return override
    for candidate in DEFAULT_CHALLENGE_PATHS:
        if os.path.isfile(candidate):
            return candidate
    matches = sorted(
        glob.glob("/kaggle/input/**/arc-agi_test_challenges.json", recursive=True)
    )
    if matches:
        return matches[0]
    raise FileNotFoundError(
        "arc-agi_test_challenges.json was not found under /kaggle/input"
    )


def _validate_grid(grid, task_id, test_index):
    if not isinstance(grid, list) or not grid or not all(isinstance(row, list) for row in grid):
        raise ValueError(f"{task_id} test[{test_index}] input must be a non-empty grid")
    width = len(grid[0])
    if width == 0 or any(len(row) != width for row in grid):
        raise ValueError(f"{task_id} test[{test_index}] input must be rectangular")
    if any(
        not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 9
        for row in grid
        for value in row
    ):
        raise ValueError(f"{task_id} test[{test_index}] input contains an invalid colour")


def build_submission(challenges):
    if not isinstance(challenges, dict):
        raise ValueError("challenge document must be an object keyed by task_id")
    submission = {}
    for task_id, task in challenges.items():
        tests = task.get("test") if isinstance(task, dict) else None
        if not isinstance(tests, list) or not tests:
            raise ValueError(f"{task_id} must contain at least one test case")
        attempts = []
        for test_index, test in enumerate(tests):
            grid = test.get("input") if isinstance(test, dict) else None
            _validate_grid(grid, task_id, test_index)
            attempts.append({"attempt_1": grid, "attempt_2": grid})
        submission[task_id] = attempts
    return submission


def main():
    with open(_challenge_path(), encoding="utf-8") as challenge_file:
        challenges = json.load(challenge_file)
    output_path = os.environ.get("ARC_SUBMISSION_PATH", DEFAULT_OUTPUT_PATH)
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as submission_file:
        json.dump(build_submission(challenges), submission_file, separators=(",", ":"))
    print(f"wrote {len(challenges)} tasks to {output_path}")


if __name__ == "__main__":
    main()
