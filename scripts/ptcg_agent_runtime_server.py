#!/usr/bin/env python3
"""JSONL server that loads a repository's real ``main.agent`` in isolation."""

import json
import os
import sys


def main() -> int:
    repo = os.getcwd()
    sys.path.insert(0, repo)
    source = os.path.join(repo, "src")
    if os.path.isdir(source):
        sys.path.insert(0, source)
    # The devcontainer can contain another checkout at Kaggle's conventional
    # path. Submission shims prefer that path when present; hide only that
    # sentinel during import so this process loads the pinned repository.
    original_isdir = os.path.isdir
    os.path.isdir = lambda value: False if value == "/kaggle_simulations/agent" else original_isdir(value)
    try:
        import main as submission
    finally:
        os.path.isdir = original_isdir
    if not hasattr(submission, "agent"):
        raise RuntimeError("main.py does not export agent")
    sys.stderr.write("READY\n")
    sys.stderr.flush()
    for line in sys.stdin:
        try:
            action = submission.agent(json.loads(line))
            payload = action
        except Exception as error:
            payload = {"__error__": f"{type(error).__name__}: {error}"}
        sys.stdout.write(json.dumps(payload) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
