# Changelog

All notable changes to this project are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [3.0.0] - 2026-05-29

### Added

- **Open source (MIT)** — `LICENSE`, [`docs/OPEN_SOURCE.md`](docs/OPEN_SOURCE.md), [`docs/differentiation.md`](docs/differentiation.md)
- **`npm run demo`** — zero API key mock pipeline with trace + experiment output
- **Coding-agent backends guide** — Codex, Gemini, Claude Code, OpenCode via `cli` provider ([`docs/coding-agent-backends.md`](docs/coding-agent-backends.md))
- **`examples/cli.config.json`** — template for real CLI providers
- **`pipeline run` CLI** — `scripts/ts/dev/pipeline-cli.ts` for non-IDE runs (see `npm run pipeline:run`)
- **DeerFlow-style reflect (MVP)** — `orchestration.reflect` on review failure / step failure ([`docs/deerflow-reflect.md`](docs/deerflow-reflect.md))
- **Dream / Dreamify / memory production** — offline workers + MCP tools (see `docs/dream.md`, `docs/dreamify.md`, `docs/memory-production.md`)
- **Local observability** — `llm_query_traces`, `llm_query_experiments` ([`docs/observability.md`](docs/observability.md))
- **`loadConfigFromPath()`** — load config from arbitrary path (demo / CLI)

### Changed

- Phase 0–8 + Backlog B2–B8 complete; orchestrator path via `AgentStepRunner` → `executePipelineStep`
- README emphasizes repo-native pipelines vs generic agent frameworks (incl. AutoGen comparison)

### Notes

- Runtime uses **tsx**; `npx tsc --noEmit` may report historical debt — see [CONTRIBUTING.md](CONTRIBUTING.md)
- Docker / devcontainer not provided; requires Node 20+, Python 3, Git locally

[3.0.0]: https://github.com/your-org/llm-pipeline/releases/tag/v3.0.0
