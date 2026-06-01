# runoff

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **DAG orchestration for repo changes, not chat loops.**  
> Race your providers, review in the pipeline, keep traces at home.

**Multi-step code-change pipelines for coding agents** — git worktree isolation, provider races, local traces. **MCP server** + **`pipeline run` CLI**.

| | |
|--|--|
| **Repo-native** | Worktrees + locks (`scripts/python/workspace_manager.py`) |
| **Config-first** | `pipeline.config.json` — implement → review → retry |
| **Host-agnostic** | Cursor, Claude Desktop, Claude Code, … + Codex / Gemini / OpenCode CLIs |
| **Local observability** | Traces + `experiments.jsonl` — no LangSmith required |

```
  IDE / CLI host (MCP)          runoff              coding-agent CLI
  ───────────────────►   DAG + governance + trace   ──►   Codex / Gemini / …
                                    │
                                    ▼
                            git worktree (target repo)
```

## Prerequisites

**Node 20+**, **Python 3**, **Git**. Check:

```bash
bash scripts/shell/check-prereqs.sh   # or: npm run check-prereqs
npm run setup:mcp                     # MCP JSON for Cursor / Claude Desktop / Claude Code
```

## Quick start (zero API keys)

```bash
git clone <repo-url> runoff && cd runoff
npm install
npm run demo
```

Mock **approved** run with trace + experiment under temp `RUNOFF_HOME`.

**30-minute path:** [`docs/guides/getting-started-30min.md`](docs/guides/getting-started-30min.md)

## Run on your repo

```bash
npm run runoff:init -- --work-dir /path/to/repo --profile feature
npm run runoff:doctor -- --config /path/to/repo/pipeline.config.json
npm run runoff:run -- \
  --prompt "Add hello() with unit tests" \
  --work-dir /path/to/repo \
  --config /path/to/repo/pipeline.config.json
```

Real CLIs: copy [`examples/configs/cli.config.json`](examples/configs/cli.config.json) → [`docs/guides/coding-agent-backends.md`](docs/guides/coding-agent-backends.md)

Example configs: `examples/configs/feature.config.json`, `examples/configs/bugfix.config.json`, `examples/configs/refactor.config.json`

**Edit config in a browser** (providers, DAG, retry — saves via local HTTP):

```bash
npm run runoff:config:edit -- --config /path/to/pipeline.config.json
```

## MCP server

```bash
npm run dev
```

```json
{
  "mcpServers": {
    "runoff": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/runoff/src/index.ts"],
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

## Race mode in 30 seconds

Put two providers in an array for any pipeline step — they run in parallel, each in its own git worktree, and you pick the winner:

```json
{
  "pipeline": {
    "implement": [["claude-code", "opencode"]],
    "review":    ["claude-code", "implement"]
  }
}
```

The pipeline pauses at `awaiting_judge`. You see both diffs:

```
candidate 0  (claude-code)   src/utils/format.ts +27 lines
  formatRelativeTime(isoString: string)   — string input only

candidate 1  (opencode/DeepSeek)   src/utils/format.ts +60 lines
  formatRelativeTime(dateInput: string | Date)  — accepts Date too
  + future dates ("2 hours from now"), week unit, edge-case guards

  npm run runoff:race:apply -- --session abc123 --winner 1
```

Same spec. Two models made different API decisions independently. With `raceFinalize: defer` you see both before any code lands.

→ Full mechanics: [**docs/features/race-mode.md**](docs/features/race-mode.md)  
→ Real benchmark data: [**docs/reference/benchmarks-data.md**](docs/reference/benchmarks-data.md)

## MCP tools (main path)

| Tool | Purpose |
|------|---------|
| `llm_run_pipeline` | Full DAG + retries + checkpoints + race pause |
| `llm_run_step` | Single step |
| `llm_query_traces` / `llm_query_experiments` | Local observability |
| `llm_race_apply` / `llm_race_abort` | Race finalization |

Full list + governance/memory tools: see [Features](#features) below.

Optional: [Dev Container](docs/operations/devcontainer.md) for reproducible local dev.

## Development & CI

| Command | Purpose |
|---------|---------|
| `npm test` | Full suite (~700+ tests) |
| `npm run ci:gates` | IPC sync + gate e2e + unit tests |
| `npm run ci:gates:smoke` | PR smoke (worktree; allow-skip without secrets) |
| `npm run check-ipc-sync` | After `src/core/ipc.ts` changes |
| `npm run typecheck` | `tsc --noEmit` (required in CI) |

After publishing to GitHub, replace `<repo-url>` above and add a CI badge (see [`docs/reference/OPEN_SOURCE.md`](docs/reference/OPEN_SOURCE.md)).

## Documentation

Full index: [**docs/README.md**](docs/README.md) · repo root files: [docs/repo-root.md](docs/repo-root.md)

| Doc | Topic |
|-----|--------|
| [**getting-started-30min.md**](docs/guides/getting-started-30min.md) | First run → real repo |
| [**differentiation.md**](docs/reference/differentiation.md) | vs LangGraph, CrewAI, AutoGen, OpenHands |
| [**coding-agent-backends.md**](docs/guides/coding-agent-backends.md) | Codex, Gemini, Claude Code, OpenCode |
| [**race-mode.md**](docs/features/race-mode.md) | Running multiple LLMs on the same step |
| [**observability.md**](docs/features/observability.md) | Trace + experiment (not LangSmith UI) |
| [**security-model.md**](docs/architecture/security-model.md) | Threat model (self-hosted) |
| [**execution-layers.md**](docs/architecture/execution-layers.md) | TS / Python / IPC ownership |
| [**timeouts.md**](docs/operations/timeouts.md) | Global / step / lock timeouts |
| [**ci-branch-protection.md**](docs/operations/ci-branch-protection.md) | Required vs optional CI smoke |
| [**supported-backends.md**](docs/reference/supported-backends.md) | Real CLI smoke matrix per release |
| [**stability-boundaries.md**](docs/operations/stability-boundaries.md) | SLA scope / single-writer / non-goals |
| [**structure.md**](docs/architecture/structure.md) | `src/` + `scripts/` layout |
| [**advanced/**](docs/advanced/README.md) | A2A, Dream, Dreamify (optional) |
| [CONTRIBUTING.md](CONTRIBUTING.md) | PR checklist |
| [OPEN_SOURCE.md](docs/reference/OPEN_SOURCE.md) | Release checklist |

## Features

- DAG pipeline, orchestrator, provider race, governance, checkpoints
- Optional: external memory, Dream offline worker, A2A federation (**experimental**)

Data: `~/.runoff/` (`RUNOFF_HOME`).

## Project status

**Open source (MIT).** Phase 0–8 complete. Runtime via **tsx**; `npm run build` for `dist/`.

**Not provided:** Docker images, multi-tenant SaaS, LangSmith-style UI.

## Layout

```
src/index.ts
src/core/ src/runtime/ src/routing/ src/observability/ src/orchestration/
scripts/python/  scripts/shell/  scripts/ts/
examples/configs/  examples/workshop/
issues/            (OPEN-BACKLOG + open/ + archive/)
```
