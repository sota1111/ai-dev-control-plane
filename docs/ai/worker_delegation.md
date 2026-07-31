# Worker Delegation Flow

## Overview

There is **no single "sole orchestrator."** Every harness role is **configured individually** and
executed via the dispatcher. `config/worker_roles.json` maps each role to an **ordered priority chain**
of workers (`claude` | `codex` | `antigravity`), and the dispatcher `scripts/ai/run_worker.sh <role>`
runs them. For a targeted issue, `scripts/ai/run_auto.sh` itself sequences the whole lifecycle as a
script (案B) — Claude participates only as the worker its chain selects for a given role, not as an
all-controlling orchestrator. (The former Gemini CLI worker was replaced by the Antigravity CLI, `agy`,
in the SOT-1334 migration.)

Humans steer the system through Linear/Discord and per-issue directives — not by talking to a worker CLI.

## Roles and workers

Roles (`config/worker_roles.json` keys): `task-check`, `decomposition`, `implementation`,
`verification`, `acceptance`, `github`, `linear-report`.

Workers and their run scripts / reports:

| Worker | Run script | Report file | CLI |
|--------|-----------|-------------|-----|
| `codex` | `scripts/ai/run_codex.sh` | `docs/ai/60_worker_codex_report.md` | `codex` |
| `claude` | `scripts/ai/run_claude.sh` | `docs/ai/55_worker_claude_report.md` | `claude` (dispatched worker) |
| `antigravity` | `scripts/ai/run_antigravity.sh` | `docs/ai/50_worker_antigravity_report.md` | `agy` |

Default priority chains (committed in `config/worker_roles.json`, primary first then fallbacks):

| Role | Default chain |
|------|---------------|
| `task-check` | `["codex","claude","antigravity"]` |
| `decomposition` | `["claude","codex","antigravity"]` |
| `implementation` | `["antigravity","codex","claude"]` |
| `verification` | `["codex","claude","antigravity"]` |
| `acceptance` | `["claude","codex","antigravity"]` |
| `github` | `["claude","codex","antigravity"]` |
| `linear-report` | `["claude","codex","antigravity"]` |

Edit `config/worker_roles.json` to reassign any role (each role is set individually). To run everything
on one worker, set every role to that worker (e.g. all `["claude"]`). The former global switches
`ALL_CLAUDE_MODE` / `WORKER_MODE` were removed.

## Dispatcher: `scripts/ai/run_worker.sh <role>`

The single entry point for role work — **AI never calls a worker CLI directly**. It:

1. reads the role's chain from `config/worker_roles.json` (or a per-issue override — see below);
2. copies the canonical, worker-agnostic instruction `prompts/roles/<role>.md` into the selected
   worker's prompt file (`prompts/codex/debug.md` / `prompts/claude/worker.md` /
   `prompts/antigravity/implement.md`);
3. runs each worker in chain order; on **non-response / usage-limit** (exit `75`) it **hands off** to
   the next worker, passing the partial report so work continues (no restart);
4. stops on the first success and prints `WORKER_DISPATCH_DONE role=<role> worker=<w> report=<path>`;
   if every worker is non-responsive prints `WORKER_DISPATCH_EXHAUSTED` and exits `75`.

Same-worker consecutive invocations reuse that CLI's session for a warm prompt cache (claude
`--session-id`/`--resume`, codex `exec resume --last`, antigravity `--continue`; disable with
`WORKER_SESSION_REUSE=0`). A dispatched Claude worker is constrained to its single role/issue and must
not orchestrate or launch runs.

## Script-driven pipeline: `scripts/ai/run_auto.sh`

For a targeted issue (autonomous runs always inject `WEBHOOK_ISSUE_ID`), `run_auto.sh` runs the roles
in order — task-check → decomposition → implementation → verification → acceptance → github →
linear-report — each through `run_worker.sh <role>`, gating on the winning report's `## Next Action`:

- `task-check` not-actionable → stop as a successful no-op;
- `verification`/`acceptance` `NEEDS_DEBUG` → loop back to `implementation` (bounded by
  `PIPELINE_MAX_DEBUG_CYCLES`, default 2);
- `BLOCKED` / `NEEDS_USER_INPUT` / chain exhausted → stop (needs human);
- all `READY_FOR_REVIEW` → complete.

The declarative graph is the only multi-role execution path. `run_auto.sh` requires a target issue;
solo mode is the only alternate lifecycle model.

## Per-issue worker override from Linear

A Linear issue description or comment can reroute roles for its own run only:

```
workers: implementation=codex, verification=claude
```

Codexのreasoning強度もLinearのIssue本文またはコメントからロール単位で指定できる。新しいコメントが
同じロールを上書きする。

```text
reasoning: task-check=ultra, decomposition=ultra, implementation=high
reasoning: solo=ultra
```

有効値は `low / medium / high / xhigh / max / ultra`。Codex以外のworkerでは指定を保持するが、
CLIへは渡さない。

`run_auto.sh` resolves this via `runner-cli resolve-worker-roles`, merges onto the base config, and
points `WORKER_ROLES_FILE` at the per-issue config. Newest occurrence wins; unmentioned roles keep the
default. Parser: `src/lib/workerRoleDirective.ts`.

## Worker report contract

Every worker report ends with a `## Next Action` line: `READY_FOR_REVIEW | NEEDS_DEBUG |
NEEDS_USER_INPUT | BLOCKED`. Missing/empty report, missing `## Next Action`, non-zero exit, or timeout
all count as non-response (exit `75`) and trigger chain hand-off.

## Project → Repository Resolution

`TARGET_REPO`（worker の作業対象レポジトリ）は、Linear issue が属する **プロジェクト名** から
決定的に判定できる。マッピングの権威ソースは `config/project_repos.json`
（`{ project, repo, localPath }` の配列）。project_repos.json に無いプロジェクトは
`config/auth/apps.json` の `name` にフォールバックする。不明なプロジェクトは未解決（null）。

- 解決モジュール: `src/lib/projectRepo.ts`
  - `resolveRepoForProject(projectName, config?)` → `{ project, repo, localPath } | null`（trim + 大小無視）
  - `loadProjectRepoConfig(configPath?)` → `ProjectRepo[]`
- CLI: `tsx src/project-repo-cli.ts "<projectName>" [--json]`（localPath を出力、不明は exit 1）
- runner 配線: `src/runner.ts triggerRun()` が issue の project を取得し解決、解決できれば
  `run_auto.sh` の spawn env に `WEBHOOK_PROJECT_NAME` / `WEBHOOK_TARGET_REPO`(=localPath) を注入。
  パイプラインはこれを `docs/ai/pipeline/context.md` に載せ、各ロールの worker に `TARGET_REPO` として渡す。
  取得・解決失敗時は env を変えず従来動作（fail-open）。
