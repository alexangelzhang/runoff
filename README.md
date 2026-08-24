# runoff

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/alexangelzhang/runoff/actions/workflows/ci-gates.yml/badge.svg)](https://github.com/alexangelzhang/runoff/actions/workflows/ci-gates.yml)

> **Run 3 AIs on the same code task. Pick the winner. The system remembers your taste.**

runoff runs **Claude Code, Codex, Gemini, OpenCode**, or any CLI/MCP-backed coding agent on the **same task, in parallel git worktrees** — then pauses so **you pick the winning diff**. Every pick is recorded locally and feeds a trace-grounded memory, so runoff learns which AI writes better code **for your codebase**. Same-step **provider race**, maker/checker loops, governance gates, durable run state, and schema-versioned **Observation** keep every run observable, recoverable, and reviewable.

```
Host loop (optional)          runoff harness (this repo)
─────────────────────         ───────────────────────────
STATE.md / priorities    →    runoff_run_pipeline (DAG)
read Observation         ←    loopAction + contextRefs + traces
MFS / manual gather      →    bounded context into triage steps
```

**What runoff is:** a **repo-native delivery harness** — not a chat framework, not a context search engine, not a SaaS control plane. Runs entirely local: no SaaS, no telemetry, traces stay on your machine (`~/.runoff/`).

**Sharp differentiators:** same-step **provider race** (compare real diffs, pick a winner), **learn from your picks** (trace-grounded memory via Dream/Dreamify), and **maker/checker** loops with L1→L3 readiness (`doctor`, `cost`, loop-sync).

Race mode remains the fastest demo — two agents, one task, you judge:

```
$ npx runoff run --prompt "Add formatRelativeTime() with edge cases"

  candidate 0  claude-code        +27 lines   string input only
  candidate 1  codex/DeepSeek     +60 lines   string | Date, future dates, week unit

  → npx runoff race apply --winner 1
```

No more hoping a single model got it right. The harness keeps the run observable, recoverable, and reviewable while agents do the work.

![runoff race demo](docs/assets/demo.gif)

**Why race instead of hoping?** A model that wrote subtly broken code is the worst model to catch its own bug — they share the same blind spots. runoff treats AI output like code review: the author and the reviewer should not be the same.

Works as an **MCP server** (Cursor, Claude Desktop, Claude Code) or a standalone **CLI**. Runs entirely local — no SaaS, no telemetry, traces stay on your machine (`~/.runoff/`).

Every pipeline result includes a schema-versioned **Observation**: status, evidence, `loopAction`, coverage gaps, and links back to artifacts and traces. Step-level **context contracts** and **completion contracts** bound what each DAG step may see and what counts as done. The control plane exposes active runs, pending approvals, and resume hints via `runoff_query_runs`.

For teams improving the harness itself, the **harness evolution control plane** (datasets, verifiers, promotion bundles — audit artifacts only) was split into the standalone, host-agnostic [`agent-evolution`](https://github.com/alexangelzhang/runoff/tree/../agent-evolution) project; runoff no longer ships or depends on it.

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
    "review": ["claude-code", "implement"]
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

Example configs: [`examples/configs/`](examples/configs/) — `feature`, `bugfix`, `refactor`, `cli`, **`pr-babysitter`**, **`daily-triage`**, **`ci-sweeper`**

Loop profiles (`npx runoff init --profile pr-babysitter`) scaffold `AGENTS.md`, `STATE.md`, and readiness checks — see [**host-loop-cookbook.md**](docs/guides/host-loop-cookbook.md).

Observation response shape: [`examples/observation-result.json`](examples/observation-result.json)

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

| Tool                                               | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runoff_run_pipeline`                              | Full DAG + retries + checkpoints + race pause                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `runoff_run_step`                                  | Single step                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `runoff_query_runs`                                | Harness control plane: run status, approvals, resume hints                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `runoff_query_context`                             | Optional MFS bridge: bounded search/cat + `contextRefs` (host-side context plane)                                                                                                                                                                                                                                                                                                                                                                                                |
| `runoff_query_traces` / `runoff_query_experiments` | Local observability                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `runoff_race_apply` / `runoff_race_abort`          | Race finalization                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### Capability maturity

| Layer                   | Status                      | What it means                                                                                                                                                                                |
| ----------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core runtime            | Production-ready local path | Config DAG, orchestration, governance, worktree isolation, durable run state, traces, Observation, context/completion contracts, loop readiness, and race apply/abort are exercised by `npm run ci:gates`. |
| Local harness-evolution control plane | **Extracted** to the standalone [`agent-evolution`](https://github.com/alexangelzhang/runoff/tree/../agent-evolution) project | Datasets, tasksets, verifiers, trajectories, rewards, rules, feedback, GC, autonomy decisions, context routes, frontier state, reports, and promotion bundles now live in that host-agnostic project, no longer in runoff. |
| Adapter contracts       | Contract-ready              | Paddock, sandbox lease, rollout, connector writeback, and training exports define stable local contracts; remote lifecycle or arbitrary blackbox execution requires explicit adapters.       |
| Experimental / optional | Opt-in                      | A2A federation, external memory backends, Dream/Dreamify, OTel collector, and real-provider smoke depend on local environment and remain opt-in.                                             |

CLI equivalent for the same control plane:

```bash
npm run runoff:runs -- list --config /path/to/pipeline.config.json
npm run runoff:runs -- show <runId> --config /path/to/pipeline.config.json
```

The harness-evolution CLI (`pipeline harness …`) moved to the standalone `agent-evolution` project; it is no longer part of runoff.

Full list + governance/memory tools: [`docs/README.md`](docs/README.md)

## Why runoff?

|                                |                                                                                                                                  runoff                                                                                                                                   |  LangGraph   |  CrewAI   |  AutoGen   | OpenHands  |
| ------------------------------ | :-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :----------: | :-------: | :--------: | :--------: |
| Declarative config DAG (JSON)  |                                                                                                                                    ✅                                                                                                                                     |  code-first  | Crew/Task | code-first | UI + agent |
| Git worktree + lock contract   |                                                                                                                                    ✅                                                                                                                                     |      —       |     —     |     —      |  partial   |
| Provider race + judge pause    |                                                                                                                                    ✅                                                                                                                                     |      —       |     —     |     —      |     —      |
| MCP tool surface for IDE hosts |                                                                                                                                    ✅                                                                                                                                     |   optional   |  recent   |     —      | different  |
| Durable run control plane      |                                                                                                                                    ✅                                                                                                                                     | checkpointer |  partial  |  partial   |  partial   |
| Observation + local trace/eval |                                                                                                                                    ✅                                                                                                                                     |  +LangSmith  |    DIY    |    DIY     |  partial   |
| Harness evolution substrate    | ✅ local control-plane artifacts + adapter contracts for trigger/role/connectors/taskset/verifier/trajectory/replay/training-export/paddock/sandbox/rollout/reward/rule/feedback/gc/autonomy/context/skill-patch/rejected-buffer/dataset/run/report/audit/frontier/export |     DIY      |    DIY    |    DIY     |  partial   |

Full comparison: [`docs/reference/differentiation.md`](docs/reference/differentiation.md)

## Prerequisites

**Node 20+**, **Python 3**, **Git**

```bash
bash scripts/shell/check-prereqs.sh
```

## Development & CI

| Command                  | Purpose                               |
| ------------------------ | ------------------------------------- |
| `npm test`               | Full suite (~800 tests)               |
| `npm run ci:gates`       | IPC sync + gate e2e + unit tests      |
| `npm run ci:gates:smoke` | PR smoke (allow-skip without secrets) |
| `npm run check-ipc-sync` | After `src/core/ipc.ts` changes       |
| `npm run typecheck`      | `tsc --noEmit` (required in CI)       |

## Documentation

Full index: [**docs/README.md**](docs/README.md)

| Doc                                                              | Topic                                      |
| ---------------------------------------------------------------- | ------------------------------------------ |
| [getting-started-30min.md](docs/guides/getting-started-30min.md) | First run → real repo                      |
| [host-loop-cookbook.md](docs/guides/host-loop-cookbook.md)       | Schedule host loops (L1→L3)                 |
| [harness-vs-loop.md](docs/guides/harness-vs-loop.md)             | Harness vs loop vocabulary + doctor scoring  |
| [coding-agent-backends.md](docs/guides/coding-agent-backends.md) | Codex, Gemini, Claude Code, OpenCode       |
| [race-mode.md](docs/features/race-mode.md)                       | Running multiple LLMs on the same step     |
| [observability.md](docs/features/observability.md)               | Trace + experiment (no LangSmith required) |
| [differentiation.md](docs/reference/differentiation.md)          | vs LangGraph, CrewAI, AutoGen, OpenHands   |
| [security-model.md](docs/architecture/security-model.md)         | Threat model (self-hosted)                 |
| [structure.md](docs/architecture/structure.md)                   | `src/` + `scripts/` layout                 |
| [advanced/](docs/advanced/README.md)                             | A2A, Dream, Dreamify (optional)            |

## Features

- Declarative DAG pipeline: triage → implement → verify → review (configurable)
- Host loop templates: `daily-triage`, `pr-babysitter`, `ci-sweeper` + doctor L1→L3 scoring
- Step **context contracts** + **completion contracts** + harness role isolation (planner/generator/evaluator)
- Observation layer: `loopAction`, `contextRefs`, evidence-linked claims
- Provider race mode with judge pause and worktree isolation
- Governance: policy, guardrails, plan approval gate
- Checkpoint / resume; durable run store
- Local trace + experiment logs at `~/.runoff/` (no SaaS required)
- Optional: `runoff_query_context` (MFS), external memory (Mem0/Zep), Dream, A2A federation (**experimental**) — harness evolution now lives in the standalone `agent-evolution` project

## License

MIT — [LICENSE](LICENSE)
