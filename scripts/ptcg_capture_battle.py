#!/usr/bin/env python3
"""Run one real PTCG match and capture the per-decision public board stream.

This is a superset of ``ptcg_real_runtime_match.py``: it drives the same native
cabt engine boundary with two real submission processes, but in addition to the
aggregate outcome it records the engine ``observation.current`` board snapshot at
every decision. The captured stream is the raw material the TypeScript converter
(``src/lib/ptcgObservationToBattleLog.ts``) maps into the ``ptcg-battle-log/v1``
replay contract consumed by the SOT-1907 board timeline viewer.

Only public board state is recorded (active/bench/HP/damage/energies/deck & hand
counts/prizes/discard); hidden hand contents are not captured.
"""

import argparse
import json
import os
import select
import subprocess
import sys
import time

MAX_DECISIONS = 100_000


def load_deck(repo: str) -> list[int]:
    with open(os.path.join(repo, "deck.csv"), encoding="utf-8") as handle:
        return [int(value) for value in handle.read().splitlines()[:60]]


class Contestant:
    def __init__(self, label: str, repo: str, server: str, seed: int, timeout_s: float):
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
            "PTCG_TIMING_TELEMETRY": "0",
        })
        self.process = subprocess.Popen(
            [python, server], cwd=self.repo, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
        )
        ready, _, _ = select.select([self.process.stderr], [], [], timeout_s)
        line = self.process.stderr.readline() if ready else ""
        if not line.startswith("READY"):
            raise RuntimeError(f"{label} failed to start: {line.strip() or 'timeout'}")

    def act(self, observation: dict) -> list[int]:
        assert self.process.stdin is not None and self.process.stdout is not None
        self.process.stdin.write(json.dumps(observation, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        ready, _, _ = select.select([self.process.stdout], [], [], self.timeout_s)
        if not ready:
            raise TimeoutError(f"{self.label} action timed out")
        reply = self.process.stdout.readline()
        if not reply:
            raise RuntimeError(f"{self.label} process exited")
        payload = json.loads(reply)
        if isinstance(payload, dict) and "__error__" in payload:
            raise RuntimeError(f"{self.label}: {payload['__error__']}")
        action = payload["action"] if isinstance(payload, dict) and "action" in payload else payload
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


def board_of(player: dict) -> dict:
    """Extract the public board of one player from an engine observation player."""
    def card(entry: dict) -> dict:
        return {
            "serial": entry.get("serial"),
            "cardId": entry.get("id"),
            "hp": entry.get("hp"),
            "maxHp": entry.get("maxHp"),
            "energyCount": len(entry.get("energies") or []),
            "toolCount": len(entry.get("tools") or []),
        }

    return {
        "active": [card(entry) for entry in (player.get("active") or []) if entry],
        "bench": [card(entry) for entry in (player.get("bench") or []) if entry],
        "deckCount": player.get("deckCount", 0),
        "handCount": player.get("handCount", 0),
        "prizeCount": len(player.get("prize") or []),
        "discardCount": len(player.get("discard") or []),
    }


def snapshot(observation: dict) -> dict:
    current = observation.get("current") or {}
    players = current.get("players") or []
    return {
        "turn": current.get("turn", 0),
        "yourIndex": int(current.get("yourIndex", 0)),
        "firstPlayer": current.get("firstPlayer", -1),
        "result": current.get("result", -1),
        "players": [board_of(player) for player in players],
    }


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
    parser.add_argument("--out", required=True, help="output path for the capture JSON")
    args = parser.parse_args()
    # Resolve repo paths before chdir so relative CLI paths stay correct.
    args.first_repo = os.path.abspath(args.first_repo)
    args.second_repo = os.path.abspath(args.second_repo)
    args.server = os.path.abspath(args.server)
    args.out = os.path.abspath(args.out)

    import random
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
    fault = None
    result = -1
    decisions = 0
    frames: list[dict] = []
    try:
        contestants = [
            Contestant(args.first_id, args.first_repo, args.server, args.seed, args.timeout_ms / 1000),
            Contestant(args.second_id, args.second_repo, args.server, args.seed, args.timeout_ms / 1000),
        ]
        observation, start = game.battle_start(contestants[0].deck, contestants[1].deck)
        if observation is None:
            raise RuntimeError(f"battle_start failed: player={start.errorPlayer} type={start.errorType}")
        frames.append(snapshot(observation))
        while decisions < MAX_DECISIONS:
            current = observation.get("current") or {}
            result = current.get("result", -1)
            if result != -1:
                break
            seat = int(current.get("yourIndex", 0))
            try:
                action = contestants[seat].act(observation)
            except TimeoutError as error:
                fault = {"agent": contestants[seat].label, "kind": "timeout", "message": str(error)}
                result = 1 - seat
                break
            except Exception as error:
                fault = {"agent": contestants[seat].label, "kind": "crash", "message": str(error)}
                result = 1 - seat
                break
            try:
                observation = game.battle_select(action)
            except Exception as error:
                fault = {"agent": contestants[seat].label, "kind": "illegal-action", "message": str(error)}
                result = 1 - seat
                break
            frames.append(snapshot(observation))
            decisions += 1
    except Exception as error:
        import traceback
        traceback.print_exc()
        fault = {"agent": "adapter", "kind": "adapter", "message": str(error)}
    finally:
        try:
            game.battle_finish()
        except Exception:
            pass
        for contestant in contestants:
            contestant.stop()

    outcome = "first" if result == 0 else "second" if result == 1 else "draw" if result == 2 else "unfinished"
    capture = {
        "captureVersion": "ptcg-battle-capture/v1",
        "seed": args.seed,
        "players": {"0": args.first_id, "1": args.second_id},
        "outcome": outcome,
        "winnerSeat": result if result in (0, 1) else None,
        "fault": fault,
        "decisions": decisions,
        "frames": frames,
    }
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(capture, handle, ensure_ascii=False)
    print(json.dumps({"outcome": outcome, "winnerSeat": capture["winnerSeat"],
                      "fault": fault, "decisions": decisions, "frames": len(frames),
                      "out": args.out}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
