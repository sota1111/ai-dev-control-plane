#!/usr/bin/env python3

import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("evaluate_arc_pattern_completion.py")
SPEC = importlib.util.spec_from_file_location("pattern_completion", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PatternCompletionCandidateTests(unittest.TestCase):
    def test_periodic_line_fills_unique_progression_with_latest_colour(self):
        self.assertEqual(
            MODULE._periodic_line([9, 0, 9, 0, 0, 0, 6, 0, 0]),
            [6, 0, 6, 0, 6, 0, 6, 0, 6],
        )

    def test_periodic_line_rejects_ambiguous_periods(self):
        self.assertIsNone(MODULE._periodic_line([1, 0, 1, 0, 2, 2]))

    def test_symmetry_repair_copies_only_zero_damage(self):
        grid = [[1, 2, 0], [3, 4, 3], [0, 2, 1]]
        self.assertEqual(
            MODULE._symmetry_repair(grid, "horizontal"),
            [[1, 2, 1], [3, 4, 3], [1, 2, 1]],
        )


if __name__ == "__main__":
    unittest.main()
