"""Kaggle kernel that installs and runs the registered ARC-AGI-3 champion."""

import os
from pathlib import Path
import shutil
import subprocess


CHAMPION_SOURCE = '''"""Registered observation-rule-v1 ARC-AGI-3 champion."""

from .agent import Agent
from arcengine import FrameData, GameAction, GameState


class Champion(Agent):
    MAX_ACTIONS = 80

    @property
    def name(self):
        return "observation-rule-v1.git-01d8177"

    def is_done(self, frames, latest_frame):
        return latest_frame.state is GameState.WIN

    def choose_action(self, frames, latest_frame):
        if latest_frame.state in [GameState.NOT_PLAYED, GameState.GAME_OVER]:
            action = GameAction.RESET
        else:
            preferred = (
                GameAction.ACTION1
                if latest_frame.levels_completed == 0
                else GameAction.ACTION4
            )
            available = getattr(latest_frame, "available_actions", None)
            simple = (
                sorted(
                    (
                        candidate
                        for candidate in available
                        if candidate is not GameAction.ACTION6
                    ),
                    key=lambda candidate: candidate.value,
                )
                if available
                else []
            )
            action = (
                preferred
                if not available or preferred in available
                else (simple[0] if simple else GameAction.ACTION6)
            )
            if action is GameAction.ACTION6:
                action.set_data({"x": 0, "y": 0})
        action.reasoning = "registered observation-rule-v1"
        return action
'''


if os.getenv("KAGGLE_IS_COMPETITION_RERUN"):
    competition = Path(
        "/kaggle/input/competitions/arc-prize-2026-arc-agi-3"
    )
    subprocess.run(
        [
            "python", "-m", "pip", "install", "--no-index", "--find-links",
            str(competition / "arc_agi_3_wheels"), "arc-agi", "python-dotenv",
        ],
        check=True,
    )
    subprocess.run(
        [
            "curl", "--fail", "--retry", "999", "--retry-all-errors",
            "--retry-delay", "5", "--retry-max-time", "600",
            "http://gateway:8001/api/games",
        ],
        check=True,
    )
    source = competition / "ARC-AGI-3-Agents"
    work = Path("/kaggle/working/ARC-AGI-3-Agents")
    shutil.copytree(source, work, dirs_exist_ok=True)
    (work / "agents" / "champion.py").write_text(CHAMPION_SOURCE)
    (work / "agents" / "__init__.py").write_text(
        "from typing import Type\n"
        "from dotenv import load_dotenv\n"
        "from .agent import Agent, Playback\n"
        "from .swarm import Swarm\n"
        "from .champion import Champion\n\n"
        "load_dotenv()\n"
        "AVAILABLE_AGENTS: dict[str, Type[Agent]] = {'champion': Champion}\n"
    )
    (work / ".env").write_text(
        "SCHEME=http\nHOST=gateway\nPORT=8001\nARC_API_KEY=test-key-123\n"
        "ARC_BASE_URL=http://gateway:8001/\nOPERATION_MODE=online\n"
        "ENVIRONMENTS_DIR=\nRECORDINGS_DIR=/kaggle/working/server_recording\n"
    )
    subprocess.run(
        ["python", "main.py", "--agent", "champion"],
        cwd=work,
        check=True,
        env={**os.environ, "MPLBACKEND": "agg"},
    )
else:
    import pandas as pd

    pd.DataFrame(
        [["1_0", "1", True, 1]],
        columns=["row_id", "game_id", "end_of_game", "score"],
    ).to_parquet("/kaggle/working/submission.parquet", index=False)
    print("Wrote local-run contract placeholder submission.parquet")
