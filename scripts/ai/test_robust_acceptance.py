#!/usr/bin/env python3
"""Self-test for robust_acceptance.py (SOT-2515).

Run: python3 scripts/ai/test_robust_acceptance.py
"""

import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("robust_acceptance.py")
SPEC = importlib.util.spec_from_file_location("robust_acceptance", MODULE_PATH)
assert SPEC and SPEC.loader
RA = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RA)


def losses(pairs):
    return dict(pairs)


class ComputeTests(unittest.TestCase):
    def test_few_dominated_improvement_has_small_k_star(self):
        base = losses([("a", 10), ("b", 10), ("c", 10), ("d", 10), ("e", 10)])
        treat = losses([("a", 0), ("b", 10), ("c", 10), ("d", 10), ("e", 10)])
        result = RA.compute(base, treat)
        self.assertTrue(result["improved"])
        self.assertEqual(result["k_star"], 1)
        # judgement: k*=1 not > public_size=3 -> reject (exit 1)
        self.assertEqual(RA.judge(result, 3), RA.EXIT_REJECT)
        self.assertEqual(result["judgement"], "reject")

    def test_broadly_distributed_improvement_survives_many_removals(self):
        rows = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]
        base = losses([(r, 10) for r in rows])
        treat = losses([(r, 9) for r in rows])
        result = RA.compute(base, treat)
        self.assertEqual(result["k_star"], 10)
        self.assertEqual(RA.judge(result, 3), RA.EXIT_ACCEPT)
        self.assertEqual(result["judgement"], "accept")

    def test_identical_inputs_have_zero_k_star_and_no_improvement(self):
        base = losses([("a", 10), ("b", 5), ("c", 7)])
        result = RA.compute(base, dict(base))
        self.assertFalse(result["improved"])
        self.assertEqual(result["k_star"], 0)
        self.assertEqual(result["removal_curve"], [])
        # not improved -> reject regardless of public size
        self.assertEqual(RA.judge(result, 0), RA.EXIT_REJECT)

    def test_report_only_without_public_size(self):
        base = losses([("a", 10), ("b", 10)])
        treat = losses([("a", 9), ("b", 9)])
        result = RA.compute(base, treat)
        self.assertEqual(RA.judge(result, None), RA.EXIT_ACCEPT)
        self.assertEqual(result["judgement"], "report_only")
        self.assertIsNone(result["public_size"])

    def test_higher_better_direction(self):
        rows = ["a", "b", "c", "d", "e"]
        base = losses([(r, 0.5) for r in rows])
        treat = losses([(r, 0.6) for r in rows])
        result = RA.compute(base, treat, higher_better=True)
        self.assertEqual(result["direction"], "higher_better")
        self.assertTrue(result["improved"])
        self.assertEqual(result["k_star"], 5)
        self.assertEqual(RA.judge(result, 2), RA.EXIT_ACCEPT)

    def test_regression_is_not_an_improvement(self):
        base = losses([("a", 10), ("b", 10)])
        treat = losses([("a", 11), ("b", 11)])  # worse everywhere
        result = RA.compute(base, treat)
        self.assertFalse(result["improved"])
        self.assertEqual(result["k_star"], 0)

    def test_mismatched_entity_sets_raise(self):
        base = losses([("a", 1), ("b", 2)])
        treat = losses([("a", 1)])
        with self.assertRaises(RA.DataError):
            RA.compute(base, treat)


class CsvIoTests(unittest.TestCase):
    def _write(self, tmp, name, text):
        path = tmp / name
        path.write_text(text, encoding="utf-8")
        return str(path)

    def test_reads_with_and_without_header(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            with_header = self._write(tmp, "h.csv", "entity,loss\na,1.5\nb,2.5\n")
            without = self._write(tmp, "n.csv", "a,1.5\nb,2.5\n")
            self.assertEqual(RA._read_losses(with_header), {"a": 1.5, "b": 2.5})
            self.assertEqual(RA._read_losses(without), {"a": 1.5, "b": 2.5})

    def test_non_numeric_raises(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            path = self._write(Path(d), "bad.csv", "entity,loss\na,foo\n")
            with self.assertRaises(RA.DataError):
                RA._read_losses(path)

    def test_duplicate_entity_raises(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            path = self._write(Path(d), "dup.csv", "a,1\na,2\n")
            with self.assertRaises(RA.DataError):
                RA._read_losses(path)

    def test_empty_file_raises(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            path = self._write(Path(d), "empty.csv", "entity,loss\n")
            with self.assertRaises(RA.DataError):
                RA._read_losses(path)


if __name__ == "__main__":
    unittest.main()
