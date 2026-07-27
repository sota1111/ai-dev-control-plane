"""Kaggle kernel that installs and runs the registered ARC-AGI-3 champion."""

import os
from pathlib import Path
import shutil
import subprocess


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
    shutil.copy(Path(__file__).with_name("champion_agent.py"), work / "agents" / "champion.py")
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
