# 00 Project Context

## Project Name
ai-dev-control-plane

## Purpose
[Describe the project purpose here]

## Tech Stack
- Runtime: Node.js
- Language: TypeScript (assumed)
- Testing: [to be filled]
- E2E: Playwright
- Environment: Dev Container (Docker)

## Repository Structure
[Describe key directories and files here]

## Key Constraints
- All AI workers run inside the Dev Container
- Humans steer via Linear/Discord and per-issue directives; there is no single "sole orchestrator"
- Each harness role (task-check / decomposition / implementation / verification / acceptance / github /
  linear-report) is configured individually in `config/worker_roles.json` and dispatched by
  `scripts/ai/run_worker.sh` to a worker (`claude` | `codex` | `antigravity`); `run_auto.sh` sequences
  the roles as a script. See `docs/ai/worker_delegation.md`.

## Current Status
[Describe current state of the project]

## Links / References
[Add relevant links here]
