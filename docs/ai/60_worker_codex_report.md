# Worker Report

## Summary
Initial task check for **SOT-855「Newプロジェクトで新規レポジトリ作成」** (ai-dev-control-plane harness). Codex was non-responsive (usage-limit cooldown, `CODEX_COOLDOWN_ACTIVE` exit 75, until ~2026-06-21), so Claude Code performed the task check directly per the Worker Non-Response Fallback Policy.

- Status: In Progress (moved Todo→In Progress this run). Priority: None. Labels: none.
- **Actionable: YES.** The prior PLAN is resolved by the human's 2026-06-19 11:35 comment: trigger = Linear project named "New", create EMPTY PUBLIC repo under `sota1111`, append local path, 承認不要 (autonomous). Now an IMPLEMENT task.

## Changed Files
- none (task check only)

## Commands Run
- `bash scripts/ai/run_codex.sh` → exit 75 (Codex non-responsive, usage-limit cooldown)
- Claude Code fallback inspection: reads of `src/lib/projectRepo.ts`, `src/runner.ts`, `config/project_repos.json`; `gh auth status` (logged in as `sota1111`); Linear MCP `list_projects` (confirmed a Project literally named **"New"** exists, id `04271084-...`).

## Key Findings
- **Repo resolution today:** `resolveRepoForProject()` (`src/lib/projectRepo.ts:91`) returns `null` for projects not in `config/project_repos.json` / `config/auth/apps.json`. `triggerRun()` (`src/runner.ts:1467`) then logs `no repo mapping ... (fail-open, no TARGET_REPO injected)` and runs on the control-plane repo. No repo-creation path exists.
- **Where "New" is read:** `getIssueProjectName()` (`src/runner.ts:270`) already fetches `issue.project.name` via GraphQL. The "New" marker is a **Linear Project named "New"** (not a project/issue label — `list_project_labels` and `list_issue_labels` for "New" both return empty). Trigger = `projectName === "New"` (case-insensitive).
- **gh CLI:** authenticated as `sota1111`; `gh repo create` available. No static blockers.

## Acceptance Criteria (derived)
- [ ] When the triggering issue's Linear project is "New", the harness creates an empty public `sota1111/<name>` repo (idempotent: skip if it already exists) and injects it as the target repo for the run.
- [ ] The new repo's localPath (`/workspaces/<name>`) is appended to `config/project_repos.json` so subsequent runs resolve it normally (prevents double-creation).
- [ ] Non-"New" projects and unmapped projects keep the existing fail-open behavior (no regression).
- [ ] Unit tests cover slug/name derivation, idempotent skip, and config append.

## Risks
- Repo NAME source was ambiguous (project is literally "New" → cannot slug to a unique name). Interactive clarification was attempted but unanswerable in autonomous webhook mode. Decision (documented in Linear + PR): name resolution order = explicit `repo: <name>` directive in issue body → slug(issue title) → `new-<issue-identifier>` fallback; idempotent skip-if-exists. No public repo is created by this PR itself (mechanism only; gated at runtime).
- Recommended worker: **Gemini (IMPLEMENT)**; fall back to Claude Code if Gemini non-responsive.

## Next Action
READY_FOR_REVIEW
