#!/usr/bin/env python3
"""Dependency-free JSONL entrypoint for the registered ARC-AGI-3 champion."""

from __future__ import annotations

import json
import sys
from typing import Any

CHAMPION_ID = "observation-rule-v1"
ARTIFACT_ID = "git:01d8177"
EVALUATION_FINGERPRINT = (
    "339695bade7dba7fd964558e407984d0842168544a0cbf4d8825414b96042218"
)


def _integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def choose_action(frame: Any) -> dict[str, Any]:
    """Map one production FrameData object to a legal, deterministic GameAction."""
    if not isinstance(frame, dict):
        raise ValueError("FrameData must be an object")
    available = frame.get("available_actions")
    if (
        not isinstance(available, list)
        or not available
        or any(not _integer(action) or action < 1 or action > 6 for action in available)
    ):
        raise ValueError("available_actions must contain action ids 1 through 6")
    if len(set(available)) != len(available):
        raise ValueError("available_actions must not contain duplicates")
    levels = frame.get("levels_completed")
    if not _integer(levels) or levels < 0:
        raise ValueError("levels_completed must be a non-negative integer")

    # The promoted observation rule is expressed against the production contract:
    # start with ACTION1, then advance with ACTION4, falling back deterministically
    # to the smallest legal simple action. ACTION6 is never selected implicitly
    # because it requires task-specific coordinates.
    preferred = 1 if levels == 0 else 4
    simple = sorted(action for action in available if action != 6)
    if preferred in available:
        return {"action": preferred}
    if simple:
        return {"action": simple[0]}
    return {"action": 6, "data": {"x": 0, "y": 0}}


def manifest() -> dict[str, str]:
    return {
        "schemaVersion": "arc-agi-3-exec-manifest/v1",
        "candidateId": CHAMPION_ID,
        "artifactId": ARTIFACT_ID,
        "evaluationFingerprint": EVALUATION_FINGERPRINT,
        "promotedAt": "2026-07-25T23:45:00.000Z",
        "protocol": "jsonl-stdin-stdout/v1",
    }


def main() -> int:
    if sys.argv[1:] == ["--manifest"]:
        print(json.dumps(manifest(), separators=(",", ":"), sort_keys=True))
        return 0
    if sys.argv[1:]:
        print("usage: arc_agi3_champion_exec.py [--manifest]", file=sys.stderr)
        return 2

    for line_number, line in enumerate(sys.stdin, 1):
        if not line.strip():
            continue
        try:
            frame = json.loads(line)
            print(json.dumps(choose_action(frame), separators=(",", ":"), sort_keys=True))
        except (json.JSONDecodeError, ValueError) as error:
            print(f"line {line_number}: {error}", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
