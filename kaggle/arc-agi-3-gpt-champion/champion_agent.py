"""Official ARC-AGI-3 framework adapter for observation-rule-v1."""

from typing import Any

from arcengine import FrameData, GameAction, GameState

from .agent import Agent


class Champion(Agent):
    MAX_ACTIONS = 80

    @property
    def name(self) -> str:
        return "observation-rule-v1.git-01d8177"

    def is_done(self, frames: list[FrameData], latest_frame: FrameData) -> bool:
        return latest_frame.state is GameState.WIN

    def choose_action(
        self, frames: list[FrameData], latest_frame: FrameData
    ) -> GameAction:
        if latest_frame.state in [GameState.NOT_PLAYED, GameState.GAME_OVER]:
            action = GameAction.RESET
        else:
            preferred = GameAction.ACTION1 if latest_frame.levels_completed == 0 else GameAction.ACTION4
            available = getattr(latest_frame, "available_actions", None)
            simple = (
                sorted(
                    (candidate for candidate in available if candidate is not GameAction.ACTION6),
                    key=lambda candidate: candidate.value,
                )
                if available
                else []
            )
            action = preferred if not available or preferred in available else (
                simple[0] if simple else GameAction.ACTION6
            )
            if action is GameAction.ACTION6:
                action.set_data({"x": 0, "y": 0})
        action.reasoning = "registered observation-rule-v1"
        return action
