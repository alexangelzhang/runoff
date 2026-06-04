# runoff

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/alexangelzhang/runoff/actions/workflows/ci-gates.yml/badge.svg)](https://github.com/alexangelzhang/runoff/actions/workflows/ci-gates.yml)

> **Run two coding agents on the same task. Pick the winner.**

Give runoff one prompt. It runs **Claude Code and Codex** (or any two providers) on the **identical task** in parallel git worktrees. Both produce real diffs. You see them side by side, pick the one you want, and it merges. The other disappears.

```
$ npx runoff run --prompt "Add formatRelativeTime() with edge cases"

  candidate 0  claude-code        +27 lines   string input only
  candidate 1  codex/DeepSeek     +60 lines   string | Date, future dates, week unit

  → npx runoff race apply --winner 1
```

No more hoping a single model got it right. Two models compete. You decide.

![runoff race demo](docs/assets/demo.gif)

**Why race instead of hoping?** A model that wrote subtly broken code is the worst model to catch its own bug — they share the same blind spots. runoff treats AI output like code review: the author and the reviewer should not be the same.

Works as an **MCP server** (Cursor, Claude Desktop, Claude Code) or a standalone **CLI**. Runs entirely local — no SaaS, no telemetry, traces stay on your machine.

## Install

```bash
npx runoff init --work-dir /path/to/your/repo
```

Or clone to develop / self-host:

```bash
git clone https://github.com/alexangelzhang/runoff.git && cd runoff
npm install
npm run demo          # zero API keys — mock run with trace + experiment
```

## Race mode

Put two providers in an array — they run in parallel, each in its own git worktree, and the pipeline pauses for you to pick:

```json
{
  "pipeline": {
    "implement": [["claude-code", "opencode"]],
    "review":    ["claude-code", "implement"]
  }
}
```

```
candidate 0  (claude-code)      src/utils/format.ts  +27 lines
  formatRelativeTime(isoString: string)   — string input only

candidate 1  (opencode/DeepSeek)  src/utils/format.ts  +60 lines
  formatRelativeTime(dateInput: string | Date)  — accepts Date too
  + future dates ("2 hours from now"), week unit, edge-case guards

npx runoff race apply --session abc123 --winner 1
```

Same spec. Two models, different API decisions. With `raceFinalize: defer` you see both diffs before any code lands.

→ Full mechanics: [**docs/features/race-mode.md**](docs/features/race-mode.md)
→ Real races with diffs: [**docs/reference/race-showcase.md**](docs/reference/race-showcase.md) — 6 real runs, real providers, real design decisions
→ Token cost data: [**docs/reference/benchmarks-data.md**](docs/reference/benchmarks-data.md)

## Run on your repo

```bash
# 1. Generate pipeline.config.json for your repo
npx runoff init --work-dir /path/to/repo --profile feature

# 2. Verify config + backend connectivity
npx runoff doctor --config /path/to/repo/pipeline.config.json

# 3. Run a task
npx runoff run \
  --prompt "Add hello() with unit tests" \
  --work-dir /path/to/repo \
  --config /path/to/repo/pipeline.config.json
```

Edit config in a browser (providers, DAG, retry — saves via local HTTP):

```bash
npx runoff config edit --config /path/to/pipeline.config.json
```

Example configs: [`examples/configs/`](examples/configs/) — `feature`, `bugfix`, `refactor`, `cli`

Real CLI backends: [`docs/guides/coding-agent-backends.md`](docs/guides/coding-agent-backends.md) — Codex, Gemini, Claude Code, OpenCode

## MCP server

```json
{
  "mcpServers": {
    "runoff": {
      "command": "npx",
      "args": ["runoff", "mcp"],
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

Auto-configure for Cursor / Claude Desktop / Claude Code:

```bash
npm run setup:mcp
```

| Tool | Purpose |
|------|---------|
| `runoff_run_pipeline` | Full DAG + retries + checkpoints + race pause |
| `runoff_run_step` | Single step |
| `runoff_query_traces` / `runoff_query_experiments` | Local observability |
| `runoff_race_apply` / `runoff_race_abort` | Race finalization |

Full list + governance/memory tools: [`docs/README.md`](docs/README.md)

## Why runoff?

| | runoff | LangGraph | CrewAI | AutoGen | OpenHands |
|-|:------:|:---------:|:------:|:-------:|:---------:|
| Declarative config DAG (JSON) | ✅ | code-first | Crew/Task | code-first | UI + agent |
| Git worktree + lock contract | ✅ | — | — | — | partial |
| Provider race + judge pause | ✅ | — | — | — | — |
| MCP tool surface for IDE hosts | ✅ | optional | recent | — | different |
| Local trace + experiment eval | ✅ | +LangSmith | DIY | DIY | partial |

Full comparison: [`docs/reference/differentiation.md`](docs/reference/differentiation.md)

## Prerequisites

**Node 20+**, **Python 3**, **Git**

```bash
bash scripts/shell/check-prereqs.sh
```

## Development & CI

| Command | Purpose |
|---------|---------|
| `npm test` | Full suite (~800 tests) |
| `npm run ci:gates` | IPC sync + gate e2e + unit tests |
| `npm run ci:gates:smoke` | PR smoke (allow-skip without secrets) |
| `npm run check-ipc-sync` | After `src/core/ipc.ts` changes |
| `npm run typecheck` | `tsc --noEmit` (required in CI) |

## Documentation

Full index: [**docs/README.md**](docs/README.md)

| Doc | Topic |
|-----|-------|
| [getting-started-30min.md](docs/guides/getting-started-30min.md) | First run → real repo |
| [coding-agent-backends.md](docs/guides/coding-agent-backends.md) | Codex, Gemini, Claude Code, OpenCode |
| [race-mode.md](docs/features/race-mode.md) | Running multiple LLMs on the same step |
| [observability.md](docs/features/observability.md) | Trace + experiment (no LangSmith required) |
| [differentiation.md](docs/reference/differentiation.md) | vs LangGraph, CrewAI, AutoGen, OpenHands |
| [security-model.md](docs/architecture/security-model.md) | Threat model (self-hosted) |
| [structure.md](docs/architecture/structure.md) | `src/` + `scripts/` layout |
| [advanced/](docs/advanced/README.md) | A2A, Dream, Dreamify (optional) |

## Features

- Declarative DAG pipeline: implement → review → retry
- Provider race mode with judge pause and worktree isolation
- Governance: policy, guardrails, plan approval gate
- Checkpoint / resume; durable run store
- Local trace + experiment logs at `~/.runoff/` (no SaaS required)
- Optional: external memory, Dream offline worker, A2A federation (**experimental**)

## License

MIT — [LICENSE](LICENSE)
