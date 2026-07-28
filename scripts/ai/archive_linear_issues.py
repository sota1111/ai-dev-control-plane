import os
import sys
import json
import argparse
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path

DEFAULT_LINEAR_API_TIMEOUT_SECONDS = 30.0


def get_linear_api_timeout():
    """Return the socket timeout used for both connect and response reads."""
    raw = os.environ.get("LINEAR_API_TIMEOUT_SECONDS", "")
    if not raw:
        return DEFAULT_LINEAR_API_TIMEOUT_SECONDS
    try:
        timeout = float(raw)
    except ValueError:
        print(
            f"WARN: invalid LINEAR_API_TIMEOUT_SECONDS={raw!r}; "
            f"using {DEFAULT_LINEAR_API_TIMEOUT_SECONDS:g}s",
            file=sys.stderr,
        )
        return DEFAULT_LINEAR_API_TIMEOUT_SECONDS
    if timeout <= 0:
        print(
            f"WARN: LINEAR_API_TIMEOUT_SECONDS must be positive; "
            f"using {DEFAULT_LINEAR_API_TIMEOUT_SECONDS:g}s",
            file=sys.stderr,
        )
        return DEFAULT_LINEAR_API_TIMEOUT_SECONDS
    return timeout


def get_linear_api_key():
    key = os.environ.get("LINEAR_API_KEY")
    if not key:
        print("ERROR: LINEAR_API_KEY is not set.")
        sys.exit(1)
    return key

def call_linear_api(query, variables=None):
    url = "https://api.linear.app/graphql"
    headers = {
        "Content-Type": "application/json",
        "Authorization": get_linear_api_key()
    }
    data = {
        "query": query,
        "variables": variables or {}
    }
    
    req = urllib.request.Request(url, data=json.dumps(data).encode("utf-8"), headers=headers)
    try:
        # urllib applies this socket timeout to connection establishment and
        # subsequent blocking reads, preventing a half-open API connection from
        # holding the autonomous-runner lock indefinitely.
        with urllib.request.urlopen(req, timeout=get_linear_api_timeout()) as response:
            res_data = json.loads(response.read().decode("utf-8"))
            if "errors" in res_data:
                print(f"API Error: {json.dumps(res_data['errors'], indent=2)}")
                return None
            return res_data.get("data")
    except urllib.error.URLError as e:
        print(f"URL Error: {e}")
        return None

def fetch_all_issues(progress_stream=sys.stdout):
    query = """
    query Issues($after: String) {
      issues(first: 250, after: $after, includeArchived: false) {
        nodes {
          id
          identifier
          title
          description
          state { name type }
          labels { nodes { name } }
          createdAt
          updatedAt
          url
          parent { id identifier title }
          children { nodes { id identifier title } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
    """
    all_nodes = []
    after = None
    
    print("Linear から Issue を取得中...", end="", flush=True, file=progress_stream)
    while True:
        variables = {"after": after}
        data = call_linear_api(query, variables)
        if not data or "issues" not in data:
            break

        issues_data = data["issues"]
        all_nodes.extend(issues_data["nodes"])
        print(".", end="", flush=True, file=progress_stream)

        page_info = issues_data["pageInfo"]
        if not page_info["hasNextPage"]:
            break
        after = page_info["endCursor"]

    print(f" 完了 ({len(all_nodes)} 件)", file=progress_stream)
    return all_nodes

def archive_issue_mutation(issue_id):
    query = """
    mutation ArchiveIssue($id: String!) {
      issueArchive(id: $id) {
        success
      }
    }
    """
    variables = {"id": issue_id}
    data = call_linear_api(query, variables)
    if data and data.get("issueArchive", {}).get("success"):
        return True
    return False

# State types that must never be auto-archived: an Issue actively being worked
# (In Progress = Linear state type "started") must not be swept by the capacity
# preflight, otherwise a run's own in-flight child Issue gets archived out from
# under it (SOT-1545 / SOT-1543 incident).
PROTECTED_STATE_TYPES = ("started",)


def _is_child(issue):
    return bool(issue.get("parent"))


def _state_type(issue):
    return (issue.get("state") or {}).get("type")


def _normalize_exclude_ids(exclude_ids):
    """Normalise an exclude-id set for tolerant matching.

    Accepts UUIDs (e.g. ``WEBHOOK_ISSUE_ID``) and human identifiers (e.g.
    ``SOT-1543``). Identifiers are matched case-insensitively (upper-cased);
    UUIDs upper-case harmlessly and still compare equal to their own
    upper-cased form. Returns a set of upper-cased tokens.
    """
    if not exclude_ids:
        return frozenset()
    return frozenset(str(x).strip().upper() for x in exclude_ids if str(x).strip())


def _is_excluded(issue, norm_exclude_ids):
    """True when the Issue's id OR identifier is in the (normalised) exclude set."""
    if not norm_exclude_ids:
        return False
    candidates = (issue.get("id"), issue.get("identifier"))
    return any(
        c is not None and str(c).strip().upper() in norm_exclude_ids
        for c in candidates
    )


def select_archive_candidates(
    issues,
    parent_target_count=150,
    child_target_count=50,
    protected_state_types=PROTECTED_STATE_TYPES,
    exclude_ids=None,
):
    """Choose which Issues to archive, honouring the SOT-1545 priority spec.

    Rules:
    - Parent Issues are kept within ``parent_target_count`` (default 150);
      child Issues within ``child_target_count`` (default 50). Each category is
      capped independently — there is no single flat total cap.
    - Within each category, the OLDEST (createdAt ascending) excess Issues are
      archived first; newer Issues are never archived before older ones.
    - Issues whose state type is in ``protected_state_types`` (In Progress by
      default) are excluded from candidacy so active work is never swept.
    - Issues whose id OR identifier is in ``exclude_ids`` (run-ownership: the
      target Issue an active run is holding) are excluded from candidacy
      REGARDLESS of state — this protects a run's own target even while it is
      still ``Todo`` (SOT-1546), which the state-based guard above cannot do
      because the state-transition to In Progress may not have happened yet.

    Returns ``(archive_parents, archive_children)`` — lists ordered oldest-first.
    """
    norm_exclude_ids = _normalize_exclude_ids(exclude_ids)

    parents = [i for i in issues if not _is_child(i)]
    children = [i for i in issues if _is_child(i)]

    def eligible(pool):
        elig = [
            i
            for i in pool
            if _state_type(i) not in protected_state_types
            and not _is_excluded(i, norm_exclude_ids)
        ]
        elig.sort(key=lambda x: x["createdAt"])
        return elig

    elig_parents = eligible(parents)
    elig_children = eligible(children)

    # Excess is measured against the FULL category count (protected Issues still
    # occupy a slot), but only ELIGIBLE Issues can actually be archived.
    num_parents_excess = max(0, len(parents) - parent_target_count)
    num_children_excess = max(0, len(children) - child_target_count)

    archive_parents = elig_parents[:num_parents_excess]
    archive_children = elig_children[:num_children_excess]
    return archive_parents, archive_children


def main():
    parser = argparse.ArgumentParser(description="Linear Issue Archive Script")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be archived without making changes")
    parser.add_argument("--parent-target-count", type=int, default=150, help="Max number of parent Issues to keep on Linear (older excess archived first)")
    parser.add_argument("--child-target-count", type=int, default=50, help="Max number of child Issues to keep on Linear (older excess archived first)")
    parser.add_argument("--total-target-count", type=int, default=200, help="Deprecated/unused: selection is now per-type (parent/child). Kept for backward compatibility.")
    parser.add_argument("--execute", action="store_true", help="Actually perform the archive operation")
    parser.add_argument("--print-total", action="store_true", help="Print only the current total Issue count to stdout and exit (no archiving)")
    parser.add_argument(
        "--exclude-id",
        action="append",
        default=[],
        metavar="ID",
        help="Issue id (UUID) or identifier (e.g. SOT-1543) to protect from archiving "
             "regardless of state (run-ownership: the active run's target). Repeatable; "
             "also accepts a comma-separated list. (SOT-1546)",
    )

    args = parser.parse_args()

    # Build the run-ownership exclude set: split any comma-separated values and
    # drop blanks so an unset WEBHOOK_ISSUE_ID (empty string) never protects "".
    exclude_ids = {
        tok.strip()
        for raw in args.exclude_id
        for tok in str(raw).split(",")
        if tok.strip()
    }

    # Count-only mode: print just the integer total to stdout and exit.
    # Progress output is routed to stderr so callers can capture the number cleanly.
    if args.print_total:
        issues = fetch_all_issues(progress_stream=sys.stderr)
        print(len(issues))
        sys.exit(0)

    # If neither --dry-run nor --execute is provided, default to dry-run
    is_dry_run = args.dry_run or not args.execute
    parent_target_count = args.parent_target_count
    child_target_count = args.child_target_count

    issues = fetch_all_issues()

    parents = [i for i in issues if not i.get("parent")]
    children = [i for i in issues if i.get("parent")]

    # Per-type selection: parents kept <= parent_target_count, children kept <=
    # child_target_count, oldest excess archived first, In Progress Issues never
    # swept. See select_archive_candidates() for the full spec (SOT-1545).
    archive_candidates_parents, archive_candidates_children = select_archive_candidates(
        issues,
        parent_target_count=parent_target_count,
        child_target_count=child_target_count,
        exclude_ids=exclude_ids,
    )

    # Observability (SOT-1546): always emit a single line naming the run-ownership
    # Issues that were protected from archiving (which of the excluded ids actually
    # matched a live Issue), so the self-archive race is auditable from the log.
    norm_exclude = _normalize_exclude_ids(exclude_ids)
    protected_matches = [
        f"{i.get('identifier')}({i.get('id')})"
        for i in issues
        if _is_excluded(i, norm_exclude)
    ]
    print(
        "[ARCHIVE] run-ownership excluded targets: "
        f"count={len(protected_matches)} "
        f"[{', '.join(protected_matches) if protected_matches else 'none'}]"
    )

    total_candidates = len(archive_candidates_children) + len(archive_candidates_parents)
    
    if total_candidates == 0:
        print("退避対象の Issue が 0 件のため、何もしません。")
        sys.exit(0)
        
    today = datetime.now().strftime("%Y-%m-%d")
    project_root = Path(__file__).parent.parent.parent
    archive_root = project_root / ".local" / "linear-issue-archive" / today
    
    if is_dry_run:
        print("\n=== Linear Issue Archive (DRY RUN) ===")
        print(f"\n現在の総 Issue 数: {len(issues)}")
        print(f"現在の親 Issue 数: {len(parents)}")
        print(f"現在の子 Issue 数: {len(children)}")
        print(f"親 Issue 上限: {parent_target_count}")
        print(f"子 Issue 上限: {child_target_count}")
        print(f"（In Progress の Issue は退避対象から除外。各カテゴリ古い順に超過分のみ退避。）")

        print(f"\n退避対象の子 Issue 一覧 ({len(archive_candidates_children)} 件):")
        for c in archive_candidates_children:
            print(f"  - {c['identifier']}: {c['title']}  →  .local/linear-issue-archive/{today}/children/{c['identifier']}.json")
            
        if archive_candidates_parents:
            print(f"\n退避対象の親 Issue 一覧 ({len(archive_candidates_parents)} 件):")
            for p in archive_candidates_parents:
                print(f"  - {p['identifier']}: {p['title']}  →  .local/linear-issue-archive/{today}/parents/{p['identifier']}.json")
                
        remaining_parents = len(parents) - len(archive_candidates_parents)
        remaining_children = len(children) - len(archive_candidates_children)
        print(f"\n実行後に残る親 Issue 数: {remaining_parents}")
        print(f"実行後に残る子 Issue 数: {remaining_children}")
        print(f"実行後に残る総 Issue 数: {remaining_parents + remaining_children}")
        
        print("\nDRY RUN のため Linear は変更されません。")
        print("--execute オプションを付けて実行すると実際にアーカイブされます。")
        
    else:
        print("\n=== Linear Issue Archive (EXECUTE) ===")
        print(f"\n現在の総 Issue 数: {len(issues)}")
        print(f"退避対象: 子 Issue {len(archive_candidates_children)} 件 + 親 Issue {len(archive_candidates_parents)} 件 = 合計 {total_candidates} 件")
        
        all_targets = []
        for c in archive_candidates_children:
            all_targets.append((c, "child"))
        for p in archive_candidates_parents:
            all_targets.append((p, "parent"))
            
        success_save_count = 0
        success_archive_count = 0
        fail_count = 0
        
        index_data = {
            "archiveDate": today,
            "totalArchived": total_candidates,
            "children": [],
            "parents": []
        }
        
        for i, (issue, rel_type) in enumerate(all_targets, 1):
            identifier = issue["identifier"]
            title = issue["title"]
            print(f"\n[{i}/{total_candidates}] {identifier}: {title}")
            
            # Prepare data for saving
            save_data = {
                "id": issue["id"],
                "identifier": identifier,
                "title": title,
                "description": issue.get("description") or "",
                "status": issue["state"]["name"],
                "labels": [l["name"] for l in issue.get("labels", {}).get("nodes", [])],
                "createdAt": issue["createdAt"],
                "updatedAt": issue["updatedAt"],
                "url": issue["url"],
                "parentId": issue["parent"]["id"] if issue.get("parent") else None,
                "parentIdentifier": issue["parent"]["identifier"] if issue.get("parent") else None,
                "parentTitle": issue["parent"]["title"] if issue.get("parent") else None,
                "children": [{"id": c["id"], "identifier": c["identifier"], "title": c["title"]} for c in issue.get("children", {}).get("nodes", [])],
                "relationshipType": rel_type
            }
            
            # Path setup
            rel_dir = "children" if rel_type == "child" else "parents"
            target_dir = archive_root / rel_dir
            target_dir.mkdir(parents=True, exist_ok=True)
            
            json_path = target_dir / f"{identifier}.json"
            md_path = target_dir / f"{identifier}.md"
            
            try:
                # Save JSON
                with open(json_path, "w", encoding="utf-8") as f:
                    json.dump(save_data, f, indent=2, ensure_ascii=False)
                
                # Save MD
                labels_str = ", ".join(save_data["labels"]) if save_data["labels"] else "None"
                children_list = "\n".join([f"  - {c['identifier']}: {c['title']}" for c in save_data["children"]]) if save_data["children"] else "None"
                parent_info = f"{save_data['parentIdentifier']} - {save_data['parentTitle']}" if save_data["parentIdentifier"] else "None"
                
                md_content = f"""# {identifier}: {title}

- **Status**: {save_data['status']}
- **Labels**: {labels_str}
- **Created**: {save_data['createdAt']}
- **Updated**: {save_data['updatedAt']}
- **URL**: {save_data['url']}
- **Parent**: {parent_info}
- **Children**:
{children_list}
- **Relationship**: {rel_type}

## Description

{save_data['description']}
"""
                with open(md_path, "w", encoding="utf-8") as f:
                    f.write(md_content)
                
                # Verify
                if json_path.exists() and json_path.stat().st_size > 0:
                    print(f"  → 保存: {json_path.relative_to(project_root)} ... OK")
                    success_save_count += 1
                    index_data[rel_dir if rel_type == "child" else "parents"].append({
                        "identifier": identifier,
                        "title": title,
                        "jsonPath": str(json_path.relative_to(project_root))
                    })
                else:
                    print(f"  → 保存失敗: {json_path}")
                    fail_count += 1
                    continue
                
                # Linear Archive
                if archive_issue_mutation(issue["id"]):
                    print("  → Linear アーカイブ: OK")
                    success_archive_count += 1
                else:
                    print("  → Linear アーカイブ: FAILED")
                    fail_count += 1
                    
            except Exception as e:
                print(f"  → エラー発生: {e}")
                fail_count += 1
        
        # Save index.json
        try:
            archive_root.mkdir(parents=True, exist_ok=True)
            with open(archive_root / "index.json", "w", encoding="utf-8") as f:
                json.dump(index_data, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"Warning: Could not save index.json: {e}")

        print("\n=== 実行結果 ===")
        print(f"保存成功: {success_save_count} 件")
        print(f"Linear アーカイブ成功: {success_archive_count} 件")
        print(f"失敗: {fail_count} 件")

if __name__ == "__main__":
    main()
