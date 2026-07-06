"""Unit tests for restore-target selection (SOT-1554 In-Review restore).

Run: python3 scripts/ai/test_restore_linear_issues.py
"""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "restore_linear_issues", Path(__file__).with_name("restore_linear_issues.py")
)
restore = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(restore)

collect = restore.collect_restore_targets


def _write_backup(root, date, rel, identifier, status, uuid=None, title="t"):
    """Write a backup JSON mirroring archive_linear_issues.py's save_data shape."""
    d = Path(root) / date / rel
    d.mkdir(parents=True, exist_ok=True)
    payload = {
        "id": uuid or identifier,
        "identifier": identifier,
        "title": title,
        "status": status,
    }
    (d / f"{identifier}.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


def ids(items):
    return [i["identifier"] for i in items]


class CollectRestoreTargetsTest(unittest.TestCase):
    def test_selects_only_in_review(self):
        with tempfile.TemporaryDirectory() as root:
            _write_backup(root, "2026-07-05", "children", "SOT-1", "In Review")
            _write_backup(root, "2026-07-05", "children", "SOT-2", "Done")
            _write_backup(root, "2026-07-05", "parents", "SOT-3", "Todo")
            _write_backup(root, "2026-06-28", "parents", "SOT-4", "In Review")
            self.assertEqual(ids(collect(root)), ["SOT-1", "SOT-4"])

    def test_status_match_is_case_insensitive(self):
        with tempfile.TemporaryDirectory() as root:
            _write_backup(root, "2026-07-05", "children", "SOT-1", "in review")
            self.assertEqual(ids(collect(root)), ["SOT-1"])

    def test_dedupes_by_id_keeping_latest_backup(self):
        with tempfile.TemporaryDirectory() as root:
            # Same id archived on two dates; only one target should be returned.
            _write_backup(root, "2026-06-28", "children", "SOT-9", "In Review", uuid="uuid-9")
            _write_backup(root, "2026-07-05", "children", "SOT-9", "In Review", uuid="uuid-9")
            targets = collect(root)
            self.assertEqual(ids(targets), ["SOT-9"])
            # Latest date path wins.
            self.assertIn("2026-07-05", targets[0]["source"])

    def test_ignores_index_json_and_bad_files(self):
        with tempfile.TemporaryDirectory() as root:
            _write_backup(root, "2026-07-05", "children", "SOT-1", "In Review")
            (Path(root) / "2026-07-05" / "index.json").write_text(
                json.dumps({"status": "In Review", "id": "x"}), encoding="utf-8"
            )
            (Path(root) / "2026-07-05" / "children" / "broken.json").write_text(
                "{not json", encoding="utf-8"
            )
            self.assertEqual(ids(collect(root)), ["SOT-1"])

    def test_custom_status_filter(self):
        with tempfile.TemporaryDirectory() as root:
            _write_backup(root, "2026-07-05", "children", "SOT-1", "In Review")
            _write_backup(root, "2026-07-05", "children", "SOT-2", "Blocked")
            self.assertEqual(ids(collect(root, statuses=("Blocked",))), ["SOT-2"])

    def test_missing_root_returns_empty(self):
        with tempfile.TemporaryDirectory() as root:
            missing = Path(root) / "does-not-exist"
            self.assertEqual(collect(missing), [])


if __name__ == "__main__":
    unittest.main()
