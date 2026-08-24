# ai-dev-control-plane

**A webhook-driven execution control plane for AI-assisted software development.**

Humans steer the system from **Linear** (and Discord). The harness turns each Linear issue into a
full development lifecycle — triage → implementation → verification → acceptance → PR → merge →
report — executed by interchangeable AI worker CLIs (**Claude**, **Codex**, **Antigravity**). There is
no single "sole orchestrator": deterministic scripts sequence the work, and each step is dispatched to
whichever worker the configuration (or the issue itself) selects.

The result is a development line that keeps moving without a human at the keyboard: file an issue on
your phone, and come back to a merged PR with a completion report.

> **Responsibility boundary:** this repository no longer schedules or originates recurring research
> work. Hypothesis management, experiment selection, and automatic research-ticket creation live in
> the sibling `epistemic-research-loop` repository. This control plane validates signed Linear
> webhooks, de-duplicates them, queues eligible issues, selects workers, executes, retries, and
> reports results. Historical drafting commands are read-only during migration.

---

## Table of Contents

- [Core Ideas](#core-ideas)
- [Responsibility Boundary](#responsibility-boundary)
- [Linear as the Command Surface](#linear-as-the-command-surface)
- [Architecture](#architecture)
- [The Pipeline](#the-pipeline)
- [Worker Dispatch and Fallback](#worker-dispatch-and-fallback)
- [Execution Modes](#execution-modes)
- [Incident Auto-Response](#incident-auto-response)
- [Quick Start](#quick-start)
- [Configuration Reference](#configuration-reference)
- [Documentation](#documentation)

---

## Core Ideas

1. **Humans decide; AI executes.** The human's only interfaces are Linear and Discord. Nobody types
   into a worker CLI directly — the harness writes worker prompts, collects worker reports, and
   reports back through Linear.

2. **Deterministic backbone, LLM nodes.** Scripts — not models — control the flow. The pipeline
   (`scripts/ai/run_auto.sh`, optionally a declarative graph in `config/pipeline_graph.json`) decides
   what runs next; each node is one bounded worker-CLI call. "AI does not call AI": every delegation
   goes through the dispatcher `scripts/ai/run_worker.sh`.

3. **Workers are interchangeable peers.** Claude, Codex, and Antigravity are equivalent workers. Each
   role has an ordered priority chain in `config/worker_roles.json`; a non-responsive worker (crash,
   usage limit, missing report) hands off to the next in the chain, carrying its partial report so
   work continues instead of restarting.

4. **Quality gates guard the merge.** Only changes that pass lint, typecheck, tests, diff review, and
   the issue's acceptance criteria become PRs and get merged. Failures loop back into a bounded
   debug cycle automatically.

5. **GitHub is the artifact store; Linear is the state store.** Branches, commits, PRs, and merges
   live in GitHub. Progress, decisions, review requests, and completion reports live in Linear.

> The full operating specification the workers follow is [`CLAUDE.md`](./CLAUDE.md).

---

## Responsibility Boundary

| System                    | Owns                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `epistemic-research-loop` | observation, hypotheses, preregistration, utility, falsification, belief, Research Brief, automatic experiment requests            |
| `ai-dev-control-plane`    | signed Linear webhook ingress, event de-duplication, persistent queue, worker/model dispatch, execution, retries, result reporting |
| Kaggle Solver             | features, training, inference, submission artifacts                                                                                |
| Benchmark evaluator       | submission credentials, sealed scores, final unseal                                                                                |

Experiment tickets from the research loop contain
`<!-- epistemic-research-loop:experiment-request:v1 -->` and a complete JSON contract. The webhook
validates its idempotency scope, read-only mounts, resources, seeds, outputs, and network policy
before queueing it. Ordinary human-authored Linear issues remain supported.

---

## Linear as the Command Surface

The combination with Linear is what makes this a _control plane_ rather than a scripting harness.
Linear is not just a ticket tracker here — it is the system's command bus, state store, and remote
control:

- **Issues are execution requests.** Creating an issue (or moving it to `Todo`) triggers a run via
  signed webhook. Startup/reaper reconciliation polls only to recover missed deliveries and stale
  state. The issue description _is_ the task specification.

- **Comments are live instructions.** New comments are read on every run; the newest instruction
  wins. You can change scope, request a rework, or approve a plan by commenting — including from the
  Linear mobile app, with no development machine in reach.

- **Inline directives steer execution per issue.** A single line in the description or any comment
  reconfigures how that one issue is processed, without touching any config file:

  ```text
  workers: implementation=codex, verification=claude     # per-role worker override
  workers: implementation=codex:gpt-5.5>claude:sonnet    # fallback chain with model pins
  workers: solo=claude:fable                             # one AI runs the whole lifecycle
  workers: solo=off, handoff=off                         # force per-role pipeline, no handoff
  graph: plan-with-discussion                            # select a pipeline graph variant
  ```

- **Issue creation is upstream-owned.** Human operators and approved producers such as
  `epistemic-research-loop` create execution issues. This repository consumes and executes them; it
  does not run a recurring drafting cron.

- **State is synchronized both ways.** Every GitHub event maps to a Linear action: branch created →
  comment, PR created → `In Progress` + link, PR merged → `In Review` + completion report, PR closed
  → reason comment. Statuses follow a fixed contract (`Backlog → Todo → In Progress → In Review →
Done`), and nothing is marked `Done` without verification — merged work waits in `In Review` for a
  human eye.

- **Labels change behavior.** A `Bug` label makes the run open a linked GitHub issue that auto-closes
  on merge; a `snapshot` label attaches an after-screenshot to the PR and the Linear issue;
  a `long-run` label detaches the run so it does not hold the execution lock.

- **Capacity recovery is operational.** The archive helpers remain available for administrators, but
  this repository does not create replacement research work.

---

## Architecture

```
┌──────────┐   issues / comments / directives   ┌────────────────────┐
│  Human   │◄──────────────────────────────────►│       Linear        │◄─ state sync
│ (Linear/ │                                    └─────────┬──────────┘
│ Discord) │                                              │ signed webhook
└────▲─────┘                                              ▼
     │ reports                    ┌─────────────────────────────────┐
     │ (Discord)                  │ Trigger layer                   │
     │                            │  src/webhook-server.ts (events) │
     │                            │  startup/reaper reconciliation │
     │                            └───────────────┬─────────────────┘
     │                                            │ runner.ts picks the issue
     │                            ┌───────────────▼─────────────────┐
     └────────────────────────────│ scripts/ai/run_auto.sh          │
                                  │  declarative graph engine, or   │
                                  │  single-worker solo lifecycle   │
                                  │  (config/pipeline_graph.json)   │
                                  └───────────────┬─────────────────┘
                                                  │ per node
                                  ┌───────────────▼─────────────────┐
                                  │ scripts/ai/run_worker.sh <role> │  ← the single dispatch entry
                                  │  priority chain from            │
                                  │  config/worker_roles.json;      │
                                  │  handoff on non-response (75)   │
                                  └─────┬──────────┬──────────┬─────┘
                                        ▼          ▼          ▼
                                  ┌─────────┐ ┌─────────┐ ┌─────────────┐
                                  │ Claude  │ │  Codex  │ │ Antigravity │   peer worker CLIs
                                  └─────────┘ └─────────┘ └─────────────┘
                                                  │ branch / PR / merge
                                          ┌───────▼───────┐
                                          │    GitHub     │  artifacts & history
                                          └───────────────┘
```

| Component          | Purpose                                                       | Location                                                                   |
| ------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Pipeline driver    | Sequences the lifecycle for one issue                         | `scripts/ai/run_auto.sh`                                                   |
| Pipeline graph     | Declarative node/edge definition of the pipeline (opt-in)     | `config/pipeline_graph.json`, `config/graphs/`, `src/lib/pipelineGraph.ts` |
| Worker dispatcher  | Selects a worker per role, hands off on failure               | `scripts/ai/run_worker.sh`                                                 |
| Worker run scripts | One bounded CLI call per worker                               | `scripts/ai/run_claude.sh` / `run_codex.sh` / `run_antigravity.sh`         |
| Discussion mode    | Multi-round debate between heterogeneous models               | `scripts/ai/run_discussion.sh`                                             |
| Role assignment    | Per-role worker priority chains, solo mode, model pins        | `config/worker_roles.json`                                                 |
| Role prompts       | Worker-agnostic instructions per role                         | `prompts/roles/<role>.md`                                                  |
| Trigger layer      | Signed webhook ingress plus recovery reconciliation           | `src/webhook-server.ts`, `src/lib/experimentRequest.ts`                    |
| Discord bot        | Remote status/control (`/status`, `/queue`, `/pause`, `/ask`) | `src/lib/discord*.ts`                                                      |
| Incident response  | Health probe → classify → rollback → postmortem               | `scripts/ai/incident_response.sh`, `docs/incident-response.md`             |

Target application code does **not** live here. Projects under development are cloned to
`/workspaces/<project>` and the harness works on them there; this repository is the orchestration
layer only.

---

## The Pipeline

For a targeted issue, `run_auto.sh` drives the lifecycle:

```
task-check (incl. decomposition judgment)
    → implementation → verification → acceptance → github (branch/PR/merge) → linear-report
```

After each role, the driver gates on the worker report's `## Next Action` line:

- `task-check` finds the issue non-actionable, or decomposes it into children → stop as a successful
  no-op.
- `verification` / `acceptance` report `NEEDS_DEBUG` → loop back to `implementation`, bounded by a
  shared debug budget (`PIPELINE_MAX_DEBUG_CYCLES`, default 2).
- `BLOCKED` / `NEEDS_USER_INPUT`, or every worker in a chain exhausted → stop and wait for a human.
- All roles `READY_FOR_REVIEW` → complete: PR created, merged when clean, Linear updated.

### Declarative pipeline graph

The lifecycle always runs from the concise **data-defined pipeline**
(`config/pipeline_graph.json`) unless solo mode is selected. Users list the steps in order and choose
one shared retry limit:

```json
{
  "version": 1,
  "steps": [
    "task-check",
    "implementation",
    "verification",
    "acceptance",
    "github",
    "linear-report"
  ],
  "retry": { "max": { "env": "PIPELINE_MAX_DEBUG_CYCLES", "default": 2 } }
}
```

The loader compiles this form into the internal event graph, so callers do not need to define report
events, terminal names, budgets, or visit caps. Omit `retry` to disable retries, or use a number such
as `"retry": { "max": 2 }`. The previous detailed `entry` / `nodes` / `budgets` JSON remains readable
during the compatibility period. Alternative graphs live in
`config/graphs/` and can be selected **per issue** with a `graph: <name>` directive from Linear
(e.g. `graph: plan-with-discussion` inserts a debate before planning). Validation and traversal are
handled by `runner-cli pipeline-graph validate|explain|open|advance`; `explain` prints only the ordered
steps and retry policy. A missing or invalid graph stops safely instead of switching execution
models. Validation errors name the incorrect user-facing field and include a valid replacement shape
where useful.

### Discussion mode (multi-agent debate)

`scripts/ai/run_discussion.sh` runs a **multi-round debate between heterogeneous models** (default
participants `codex:sol` + `claude:fable`) on one topic. The script controls the rounds
deterministically; each utterance is one bounded worker call appended to a shared thread
(`docs/ai/discussion/<issue>.md`). All participants agreeing in the same round produces a consensus;
otherwise, after `DISCUSSION_MAX_ROUNDS` (default 3) a moderator issues a verdict. The result lands
in `docs/ai/pipeline/discussion_<issue>.md` with a gate-compatible `## Next Action`. It runs
standalone (`--issue <ID> --topic "<question>"`) or as a graph node via `graph: plan-with-discussion`.

---

## Worker Dispatch and Fallback

`scripts/ai/run_worker.sh <role>` is the **only** entry point for delegated work:

1. The role's ordered chain is read from `config/worker_roles.json` (default for every role:
   `claude → codex → antigravity`). A Linear `workers:` directive can override it per issue,
   including per-element **model pins** (`worker:model`, e.g. `codex:gpt-5.5`, `claude:sonnet`;
   aliases like `codex:sol` → GPT-5.6 Sol and `claude:fable` → Fable 5 resolve in the run scripts).
2. Workers are tried in order. **Non-response** — exit 75, a crash, a usage limit, a timeout, or a
   missing/incomplete report — hands off to the next worker _with the partial report_, so the
   successor continues rather than restarts. Handoff can be disabled per issue (`handoff=off`).
3. Consecutive calls to the same worker reuse its CLI session to keep the prompt cache warm.
4. Only when the whole chain is exhausted does the run stop for fallback handling.

Per-worker kill switches (`CLAUDE_DISABLED` / `CODEX_DISABLED` / `ANTIGRAVITY_DISABLED`) mark a
worker temporarily down without touching role assignments. Usage-limited workers get a computed
cooldown and automatic retry scheduling.

---

## Execution Modes

- **Per-role pipeline (default).** Each role is dispatched independently through its chain — the
  doer of one step can differ from the checker of the next.
- **Solo mode.** Set `"__solo__": "<worker>"` in `config/worker_roles.json` (or `workers: solo=<worker>`
  on one issue) and a **single AI runs the entire lifecycle in one session** — no per-role handoff.
  Cheaper and faster for well-scoped tasks; the per-role chains are ignored while active.
- **Parallel lanes.** Runs serialize per repository by default. `RUNNER_SERIALIZE_SCOPE=branch`
  keys the lock to the branch instead, so different branches — even in the same repo — proceed in
  parallel, each in an isolated `git worktree` (dirty worktrees are preserved, never discarded).
  `RUNNER_WORKTREE_ISOLATION=1` gives even serial runs a per-issue worktree for safe interruption.
- **Detached long runs.** Issues labeled `long-run` execute detached so they never block the queue
  (`RUNNER_STABLE_MODE=1` forces everything back to synchronous serial execution).

---

## Incident Auto-Response

Beyond development-time self-healing, the harness includes a runtime incident loop for already
deployed services (default **off**, two-stage enablement):

```
detect (health probes) → identify → remediate (rollback) → verify recovery → postmortem
```

Rollback fires **only for deploy-caused failures** — 5xx, unreachable, or vanished routes — never for
4xx auth/rate/client errors, with an optional deploy-correlation window. Postmortems are generated
automatically under `docs/ai/incidents/`. A GCP-native variant provisions Cloud Monitoring uptime
checks and Cloud Run revision rollback without a resident host. Gates: `INCIDENT_RESPONSE_ENABLED`
(monitoring) and `INCIDENT_AUTO_REMEDIATE` (actual rollback; otherwise dry-run logs). See
[docs/incident-response.md](docs/incident-response.md).

---

## Quick Start

Everything runs inside the Dev Container (VS Code → _Dev Containers: Rebuild Container_).

**1. Install dependencies**

```bash
npm install
```

**2. Configure the environment**

```bash
cp .env.example .env
```

| Variable            | Required | Purpose                                                    |
| ------------------- | -------- | ---------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | yes      | Claude worker CLI                                          |
| `LINEAR_API_KEY`    | optional | Enables Linear polling mode (webhook/MCP auth is separate) |

Secrets stay in `.env` (untracked). Full list: [docs/environment-variables.md](docs/environment-variables.md).

**3. Authenticate the tools**

| Tool                    | Command                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| Claude CLI + Linear MCP | run `claude` → `/mcp` → select linear                                            |
| Codex CLI               | run `codex` to authenticate; Linear MCP via `codex mcp login linear`             |
| Antigravity CLI         | run `agy` to authenticate                                                        |
| GitHub CLI              | `GH_BROWSER=echo gh auth login --hostname github.com --git-protocol https --web` |

**4. Start the system (pick one)**

```bash
# A. Event-driven via Linear webhooks (recommended, low latency)
npm run dev:webhook

# B. Recovery polling (compatibility/fallback; does not create issues)
bash scripts/ai/scheduler.sh --watch      # foreground with logs
bash scripts/ai/scheduler.sh              # background; `status` / `stop` subcommands

# C. One explicitly targeted manual execution
bash scripts/ai/run_auto.sh --issue SOT-1234 --dry-run
bash scripts/ai/run_auto.sh --issue SOT-1234
```

**5. Use it**

Create a Linear issue (or set one to `Todo`). The harness picks it up, works it through the
pipeline, and reports progress as Linear comments. Check status remotely via Discord `/status`.

---

## Configuration Reference

Worker selection lives in `config/worker_roles.json` (chains, `__solo__`, `__handoff__`, default
model pins under `__models__`) — the single top-level switch. Frequently used environment flags:

| Variable                                                                     | Effect                                               | Default                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| `PIPELINE_GRAPH_FILE`                                                        | Override the unified pipeline graph file             | `config/pipeline_graph.json`                    |
| `PIPELINE_MAX_DEBUG_CYCLES`                                                  | Shared budget for debug loop-backs                   | `2`                                             |
| `RUNNER_MAX_PARALLEL`                                                        | Parallel run slots (`1` = fully serial)              | `1`                                             |
| `RUNNER_SERIALIZE_SCOPE`                                                     | Lock granularity: `repo` or `branch`                 | `repo`                                          |
| `RUNNER_WORKTREE_ISOLATION`                                                  | Per-issue git worktree even for serial runs          | off                                             |
| `RUNNER_STABLE_MODE`                                                         | Force fully serial, synchronous operation            | off                                             |
| `CLAUDE_DISABLED` / `CODEX_DISABLED` / `ANTIGRAVITY_DISABLED`                | Mark a worker temporarily down (skipped via exit 75) | off                                             |
| `DISCUSSION_PARTICIPANTS` / `DISCUSSION_MAX_ROUNDS` / `DISCUSSION_MODERATOR` | Discussion mode tuning                               | `codex:sol+claude:fable` / `3` / `claude:fable` |
| `INCIDENT_RESPONSE_ENABLED` / `INCIDENT_AUTO_REMEDIATE`                      | Incident loop / actual rollback                      | off                                             |

---

## Documentation

- [Scheduler](docs/scheduler.md) — polling modes and operations
- [Webhook server](docs/webhook.md) — event-driven startup, bootstrap scan, persistent operation
- [Execution ingress contract](docs/execution-ingress.md) — repository boundary and ERL request validation
- [Runner queue and logs](docs/runner-queue.md) — queue file, ordering, locks, retries, lanes
- [Usage limits and resume](docs/usage-limit-and-resume.md) — cooldown detection and auto-resume
- [Incident auto-response](docs/incident-response.md) — monitoring, rollback decisions, postmortems
- [Discord bot](docs/discord-bot.md) — setup and commands
- [Environment variables](docs/environment-variables.md) — full reference
- [Linear issue archiving](docs/linear-issue-archive.md) — automatic capacity management
- [Security and permissions](docs/security.md) — devcontainer least-privilege policy
- [tmux / tmuxinator](docs/tmux.md) — one-shot session bring-up
- [Remote SSH + git clone verification](docs/remote-ssh-clone-verification.md) — reachability and clone check for a remote host
- [Operating specification (CLAUDE.md)](CLAUDE.md) — the contract every worker follows
