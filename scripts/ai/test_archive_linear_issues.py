"""Unit tests for archive candidate selection (SOT-1545 archive priority).

Run: python3 scripts/ai/test_archive_linear_issues.py
"""
import importlib.util
import unittest
from pathlib import Path

# Load the module by path (filename is fine as a module for import).
_spec = importlib.util.spec_from_file_location(
    "archive_linear_issues", Path(__file__).with_name("archive_linear_issues.py")
)
archive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(archive)

select = archive.select_archive_candidates


def issue(identifier, created, is_child=False, state_type="completed"):
    return {
        "id": identifier,
        "identifier": identifier,
        "createdAt": created,
        "state": {"type": state_type, "name": state_type},
        "parent": {"id": "P"} if is_child else None,
    }


def ids(items):
    return [i["identifier"] for i in items]


class SelectArchiveCandidatesTest(unittest.TestCase):
    def test_no_excess_archives_nothing(self):
        issues = [issue(f"P{i}", f"2026-01-{i:02d}") for i in range(1, 6)]
        issues += [issue(f"C{i}", f"2026-01-{i:02d}", is_child=True) for i in range(1, 6)]
        parents, children = select(issues, parent_target_count=150, child_target_count=50)
        self.assertEqual(parents, [])
        self.assertEqual(children, [])

    def test_children_capped_at_target_oldest_first(self):
        # 53 children, cap 50 -> archive the 3 oldest children only.
        children = [
            issue(f"C{i:02d}", f"2026-01-{i:02d}T00:00:00Z", is_child=True)
            for i in range(1, 54)
        ]
        _, archive_children = select(children, parent_target_count=150, child_target_count=50)
        self.assertEqual(ids(archive_children), ["C01", "C02", "C03"])

    def test_parents_capped_at_target_oldest_first(self):
        parents = [
            issue(f"P{i:03d}", f"2026-01-01T00:{i:02d}:00Z")
            for i in range(1, 153)
        ]
        archive_parents, _ = select(parents, parent_target_count=150, child_target_count=50)
        self.assertEqual(ids(archive_parents), ["P001", "P002"])

    def test_newer_issue_not_archived_before_older(self):
        # Only 2 children over cap; the NEWEST child must survive.
        children = [
            issue("OLD", "2026-01-01T00:00:00Z", is_child=True),
            issue("MID", "2026-06-01T00:00:00Z", is_child=True),
        ] + [
            issue(f"K{i}", f"2026-03-{i:02d}T00:00:00Z", is_child=True) for i in range(1, 50)
        ] + [
            issue("NEWEST", "2026-12-31T00:00:00Z", is_child=True),
        ]
        # 52 children, cap 50 -> 2 oldest archived: OLD then next-oldest.
        _, archive_children = select(children, child_target_count=50)
        self.assertIn("OLD", ids(archive_children))
        self.assertNotIn("NEWEST", ids(archive_children))
        self.assertEqual(len(archive_children), 2)

    def test_in_progress_issue_never_archived(self):
        # Oldest child is In Progress (started) -> must be skipped; next oldest
        # eligible child is archived instead. (SOT-1543 incident.)
        children = [
            issue("ACTIVE", "2026-01-01T00:00:00Z", is_child=True, state_type="started"),
            issue("OLD2", "2026-01-02T00:00:00Z", is_child=True),
        ] + [
            issue(f"K{i}", f"2026-03-{i:02d}T00:00:00Z", is_child=True) for i in range(1, 50)
        ]
        # 51 children, cap 50 -> 1 to archive; ACTIVE protected -> OLD2 archived.
        _, archive_children = select(children, child_target_count=50)
        self.assertEqual(ids(archive_children), ["OLD2"])

    def test_parents_and_children_capped_independently(self):
        parents = [issue(f"P{i:03d}", f"2026-01-01T00:{i:02d}:00Z") for i in range(1, 153)]  # 152
        children = [issue(f"C{i:02d}", f"2026-02-01T00:{i:02d}:00Z", is_child=True) for i in range(1, 52)]  # 51
        archive_parents, archive_children = select(parents + children, parent_target_count=150, child_target_count=50)
        self.assertEqual(len(archive_parents), 2)   # 152 - 150
        self.assertEqual(len(archive_children), 1)  # 51 - 50


if __name__ == "__main__":
    unittest.main()
