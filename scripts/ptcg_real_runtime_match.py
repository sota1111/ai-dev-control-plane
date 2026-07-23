#!/usr/bin/env python3
"""Run one PTCG match with two real Kaggle submission processes.

The control-plane owns orchestration and checkpointing; this helper owns the
native cabt engine boundary.  Each submission is imported in its own process
so identically named ``agents`` packages cannot collide.
"""

import argparse
import json
import os
import random
import select
import subprocess
import sys
import time

MAX_DECISIONS = 100_000


def load_deck(repo: str) -> list[int]:
    with open(os.path.join(repo, "deck.csv"), encoding="utf-8") as handle:
        return [int(value) for value in handle.read().splitlines()[:60]]


class Contestant:
    def __init__(
        self, label: str, repo: str, server: str, seed: int, timeout_s: float, telemetry: bool
    ):
        started = time.perf_counter()
        self.label = label
        self.repo = os.path.abspath(repo)
        self.deck = load_deck(self.repo)
        self.timeout_s = timeout_s
        python = next((candidate for candidate in (
            os.path.join(self.repo, ".venv", "bin", "python"),
            os.path.join(self.repo, "venv", "bin", "python"),
        ) if os.path.exists(candidate)), sys.executable)
        env = dict(os.environ)
        env.update({
            "AGENT_SEED": str(seed),
            "PYTHONHASHSEED": str(seed),
            "PTCG_TIMING_TELEMETRY": "1" if telemetry else "0",
        })
        self.process = subprocess.Popen(
            [python, server], cwd=self.repo, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
        )
        ready, _, _ = select.select([self.process.stderr], [], [], timeout_s)
        line = self.process.stderr.readline() if ready else ""
        if not line.startswith("READY"):
            raise RuntimeError(f"{label} failed to start: {line.strip() or 'timeout'}")
        self.startup_ms = (time.perf_counter() - started) * 1000
        self.request_ms = 0.0
        self.inference_ms = 0.0

    def act(self, observation: dict) -> list[int]:
        assert self.process.stdin is not None and self.process.stdout is not None
        started = time.perf_counter()
        self.process.stdin.write(json.dumps(observation, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        ready, _, _ = select.select([self.process.stdout], [], [], self.timeout_s)
        if not ready:
            raise TimeoutError(f"{self.label} action timed out")
        reply = self.process.stdout.readline()
        if not reply:
            raise RuntimeError(f"{self.label} process exited")
        payload = json.loads(reply)
        self.request_ms += (time.perf_counter() - started) * 1000
        if isinstance(payload, dict) and "__error__" in payload:
            raise RuntimeError(f"{self.label}: {payload['__error__']}")
        if isinstance(payload, dict) and "action" in payload:
            action = payload["action"]
            self.inference_ms += float(payload.get("inferenceMs", 0.0))
        else:
            action = payload
        if not isinstance(action, list):
            raise ValueError(f"{self.label} returned a non-list action")
        return action

    def stop(self) -> None:
        try:
            if self.process.stdin:
                self.process.stdin.close()
            self.process.wait(timeout=2)
        except Exception:
            self.process.kill()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-repo", required=True)
    parser.add_argument("--server", required=True)
    parser.add_argument("--first-id", required=True)
    parser.add_argument("--first-repo", required=True)
    parser.add_argument("--second-id", required=True)
    parser.add_argument("--second-repo", required=True)
    parser.add_argument("--seed", required=True, type=int)
    parser.add_argument("--timeout-ms", type=int, default=30_000)
    parser.add_argument("--telemetry", choices=("on", "off"), default="on")
    args = parser.parse_args()
    random.seed(args.seed)
    try:
        import numpy as np

        np.random.seed(args.seed)
    except ImportError:
        pass

    engine_repo = os.path.abspath(args.engine_repo)
    sys.path.insert(0, engine_repo)
    os.chdir(engine_repo)
    from cg import game  # pylint: disable=import-outside-toplevel

    contestants: list[Contestant] = []
    started = time.perf_counter()
    fault = None
    result = -1
    decisions = 0
    think_ms = [0.0, 0.0]
    engine_ms = 0.0
    try:
        contestants = [
            Contestant(
                args.first_id, args.first_repo, args.server, args.seed,
                args.timeout_ms / 1000, args.telemetry == "on"
            ),
            Contestant(
                args.second_id, args.second_repo, args.server, args.seed,
                args.timeout_ms / 1000, args.telemetry == "on"
            ),
        ]
        engine_started = time.perf_counter()
        observation, start = game.battle_start(contestants[0].deck, contestants[1].deck)
        engine_ms += (time.perf_counter() - engine_started) * 1000
        if observation is None:
            raise RuntimeError(f"battle_start failed: player={start.errorPlayer} type={start.errorType}")
        while decisions < MAX_DECISIONS:
            current = observation.get("current") or {}
            result = current.get("result", -1)
            if result != -1:
                break
            seat = int(current.get("yourIndex", 0))
            before = time.perf_counter()
            try:
                action = contestants[seat].act(observation)
            except TimeoutError as error:
                fault = {"agent": contestants[seat].label, "kind": "timeout", "message": str(error)}
                result = 1 - seat
                break
            except Exception as error:  # real runtime crash/adapter failure
                fault = {"agent": contestants[seat].label, "kind": "crash", "message": str(error)}
                result = 1 - seat
                break
            finally:
                think_ms[seat] += (time.perf_counter() - before) * 1000
            try:
                engine_started = time.perf_counter()
                observation = game.battle_select(action)
                engine_ms += (time.perf_counter() - engine_started) * 1000
            except Exception as error:
                fault = {"agent": contestants[seat].label, "kind": "illegal-action", "message": str(error)}
                result = 1 - seat
                break
            decisions += 1
        if decisions >= MAX_DECISIONS and result == -1:
            result = -1
    except Exception as error:
        fault = {"agent": "adapter", "kind": "adapter", "message": str(error)}
    finally:
        try:
            game.battle_finish()
        except Exception:
            pass
        for contestant in contestants:
            contestant.stop()

    outcome = "first" if result == 0 else "second" if result == 1 else "draw" if result == 2 else "unfinished"
    payload = {
        "outcome": outcome,
        "fault": fault,
        "decisions": decisions,
        "thinkTimeMs": {"first": think_ms[0], "second": think_ms[1]},
        "durationMs": (time.perf_counter() - started) * 1000,
    }
    if args.telemetry == "on":
        payload["timingMs"] = {
            "processStartup": {
                "first": contestants[0].startup_ms if len(contestants) > 0 else 0.0,
                "second": contestants[1].startup_ms if len(contestants) > 1 else 0.0,
            },
            "request": {
                "first": contestants[0].request_ms if len(contestants) > 0 else 0.0,
                "second": contestants[1].request_ms if len(contestants) > 1 else 0.0,
            },
            "inference": {
                "first": contestants[0].inference_ms if len(contestants) > 0 else 0.0,
                "second": contestants[1].inference_ms if len(contestants) > 1 else 0.0,
            },
            "engine": engine_ms,
        }
    print(json.dumps(payload, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
