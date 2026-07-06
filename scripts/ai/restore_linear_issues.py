"""Restore (un-archive) Linear Issues that were mistakenly auto-archived.

Context (SOT-1554): the capacity preflight auto-archive (archive_linear_issues.py)
swept some Issues that were in **In Review** before the In-Review protection
(PROTECTED_STATE_TYPES = ("started",)) covered them. Every archived Issue is
backed up under .local/linear-issue-archive/<date>/{parents,children}/<ID>.json
with its status, so the mistakenly-archived In-Review Issues can be reconstructed
from the local backups and un-archived via the Linear API.

This script scans those backups, selects the Issues whose recorded status matches
(default "In Review"), and calls the `issueUnarchive` mutation to restore them.

Safety default mirrors archive_linear_issues.py: dry-run unless --execute.

Run:
    python3 scripts/ai/restore_linear_issues.py            # dry-run
    python3 scripts/ai/restore_linear_issues.py --execute  # actually restore
"""
import argparse
import importlib.util
import json
import sys
from pathlib import Path

# Reuse the Linear HTTP client from the archive script (single source of truth for
# the GraphQL transport / auth). Importing is side-effect free: archive_linear_issues
# only defines functions at module scope and guards execution behind __main__.
_ARCHIVE_SPEC = importlib.util.spec_from_file_location(
    "archive_linear_issues", Path(__file__).with_name("archive_linear_issues.py")
)
_archive = importlib.util.module_from_spec(_ARCHIVE_SPEC)
_ARCHIVE_SPEC.loader.exec_module(_archive)

call_linear_api = _archive.call_linear_api

DEFAULT_ARCHIVE_ROOT = (
    Path(__file__).parent.parent.parent / ".local" / "linear-issue-archive"
)
DEFAULT_STATUSES = ("In Review",)


def collect_restore_targets(archive_root, statuses=DEFAULT_STATUSES):
    """Scan local archive backups and return the Issues to un-archive.

    Walks ``<archive_root>/<date>/{parents,children}/<ID>.json`` backups, keeps the
    ones whose recorded ``status`` is in ``statuses`` (case-insensitive), and
    de-duplicates by Issue id (an id that appears in multiple daily backups keeps
    the entry from the latest backup, ordered by file path so the newest date wins).

    Pure/testable: reads only the filesystem, performs no network calls.

    Returns a list of dicts ``{id, identifier, title, status, source}`` ordered by
    identifier for stable output.
    """
    root = Path(archive_root)
    wanted = {s.strip().lower() for s in statuses if s and s.strip()}
    by_id = {}

    if not root.exists():
        return []

    # Sorted so that, for a duplicated id, a later (newer date) path overwrites an
    # earlier one deterministically.
    for path in sorted(root.rglob("*.json")):
        if path.name == "index.json":
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue

        status = str(data.get("status") or "").strip().lower()
        issue_id = data.get("id")
        if not issue_id or status not in wanted:
            continue

        by_id[issue_id] = {
            "id": issue_id,
            "identifier": data.get("identifier") or "",
            "title": data.get("title") or "",
            "status": data.get("status") or "",
            "source": str(path),
        }

    return sorted(by_id.values(), key=lambda x: x["identifier"])


def unarchive_issue_mutation(issue_id):
    query = """
    mutation UnarchiveIssue($id: String!) {
      issueUnarchive(id: $id) {
        success
      }
    }
    """
    data = call_linear_api(query, {"id": issue_id})
    return bool(data and data.get("issueUnarchive", {}).get("success"))


def main():
    parser = argparse.ArgumentParser(
        description="Restore (un-archive) mistakenly-archived Linear Issues by status."
    )
    parser.add_argument(
        "--archive-root",
        default=str(DEFAULT_ARCHIVE_ROOT),
        help="Root of the local archive backups (default: .local/linear-issue-archive).",
    )
    parser.add_argument(
        "--status",
        action="append",
        default=[],
        metavar="STATUS",
        help="Status name to restore (repeatable). Default: 'In Review'.",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually perform the un-archive. Without it, dry-run only.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be restored without making changes (default).",
    )
    args = parser.parse_args()

    statuses = tuple(args.status) if args.status else DEFAULT_STATUSES
    is_dry_run = args.dry_run or not args.execute

    targets = collect_restore_targets(args.archive_root, statuses=statuses)

    print("=== Linear Issue Restore ({}) ===".format("DRY RUN" if is_dry_run else "EXECUTE"))
    print("対象ステータス: {}".format(", ".join(statuses)))
    print("復活対象: {} 件".format(len(targets)))
    for t in targets:
        print("  - {}: {}  (status={})".format(t["identifier"], t["title"], t["status"]))

    if not targets:
        print("復活対象の Issue が 0 件のため、何もしません。")
        sys.exit(0)

    if is_dry_run:
        print("\nDRY RUN のため Linear は変更されません。")
        print("--execute オプションを付けて実行すると実際に復活（アンアーカイブ）されます。")
        sys.exit(0)

    success = 0
    fail = 0
    for i, t in enumerate(targets, 1):
        print("\n[{}/{}] {}: {}".format(i, len(targets), t["identifier"], t["title"]))
        if unarchive_issue_mutation(t["id"]):
            print("  → Linear アンアーカイブ: OK")
            success += 1
        else:
            print("  → Linear アンアーカイブ: FAILED")
            fail += 1

    print("\n=== 実行結果 ===")
    print("復活成功: {} 件".format(success))
    print("失敗: {} 件".format(fail))
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
