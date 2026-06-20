# Documentation index

> Last updated: 2026-05-26

## Start here

| Doc | Audience |
|-----|----------|
| [guides/getting-started-30min.md](guides/getting-started-30min.md) | First run → real repo |
| [reference/differentiation.md](reference/differentiation.md) | Why runoff vs LangGraph / CrewAI / OpenHands |
| [guides/coding-agent-backends.md](guides/coding-agent-backends.md) | Codex, Gemini, Claude Code, OpenCode |
| [guides/testing.md](guides/testing.md) | `tests/unit`, `e2e`, `integration`, `federation` |

## By topic

### Guides

- [getting-started-30min.md](guides/getting-started-30min.md)
- [mcp-host-setup.md](guides/mcp-host-setup.md)
- [mock-to-real-cli.md](guides/mock-to-real-cli.md)
- [coding-agent-backends.md](guides/coding-agent-backends.md)
- [testing.md](guides/testing.md)

### Architecture

- [structure.md](architecture/structure.md) — `src/` layout
- [execution-layers.md](architecture/execution-layers.md) — TS / Python / IPC ownership
- [trace-lifecycle.md](architecture/trace-lifecycle.md)
- [governance-config.md](architecture/governance-config.md)
- [pipeline-hooks-runtime.md](architecture/pipeline-hooks-runtime.md)
- [memory-layers.md](architecture/memory-layers.md) — session vs persistent vs Dream
- [security-model.md](architecture/security-model.md)

### Features

- [race-mode.md](features/race-mode.md) — running multiple LLMs on the same step, picking or merging the best result
- [observability.md](features/observability.md) — Observation layer + traces + harness evolution substrate · [observability-eval.md](features/observability-eval.md)
- [memory-production.md](features/memory-production.md) · [memory-dream-roadmap.md](features/memory-dream-roadmap.md)
- [dream.md](features/dream.md) · [dreamify.md](features/dreamify.md)
- [deerflow-reflect.md](features/deerflow-reflect.md)
- [external-memory.md](features/external-memory.md)
- [a2a-federation.md](features/a2a-federation.md)
- [advanced/README.md](advanced/README.md) — A2A, Dream, pins (index)

### Operations

- [ci-branch-protection.md](operations/ci-branch-protection.md)
- [timeouts.md](operations/timeouts.md)
- [stability-boundaries.md](operations/stability-boundaries.md)
- [real-provider-smoke.md](operations/real-provider-smoke.md) · [runner checklist](operations/real-provider-smoke-runner-checklist.md)
- [release-publish-checklist.md](operations/release-publish-checklist.md) · [release-workflow-template.md](operations/release-workflow-template.md)
- [devcontainer.md](operations/devcontainer.md)
- [observability-collector-local.md](operations/observability-collector-local.md)

### Reference

- [OPEN_SOURCE.md](reference/OPEN_SOURCE.md)
- [benchmarks.md](reference/benchmarks.md) — why there's no SWE-bench number, and what is measurable
- [industry-benchmark.md](reference/industry-benchmark.md) · [benchmark-pins.json](reference/benchmark-pins.json)
- [supported-backends.md](reference/supported-backends.md)

### Design & history

- [design/pipeline-hooks-design.md](design/pipeline-hooks-design.md)
- [history/roadmap-delivered-phases.md](history/roadmap-delivered-phases.md) — Phase 0–8 detail (archived)

### Repo root

- [repo-root.md](repo-root.md) — `pipeline.config.json`, compose files, dot-directories

## Examples & issues

- [../examples/README.md](../examples/README.md) — `configs/*.config.json`, observation response example, optional `workshop/`
- [../issues/README.md](../issues/README.md) — open backlog + `archive/` close-outs

## Product roadmap

Executive summary: **[../ROADMAP.md](../ROADMAP.md)**. Open engineering items: **[../issues/OPEN-BACKLOG.md](../issues/OPEN-BACKLOG.md)**.
