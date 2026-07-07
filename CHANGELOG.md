# Changelog

All notable changes to this project are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **Project positioning** — README, differentiation, and OPEN_SOURCE docs describe runoff as a delivery harness + host-loop control plane (not race-only demo).
- **Repo hygiene** — remove committed `.venv/`, `__pycache__/`, `data/sessions/` notes, and `.playwright-mcp/` logs from git; expand `.gitignore` and [docs/repo-root.md](docs/repo-root.md).

### Fixed

- **Race apply failure** — failed winner apply now cleans all workspaces, clears checkpoint race fields, updates trace, and removes in-memory session (no orphaned `pendingRaceTraceId`)
- **Race apply success + trace persist failure** — throws after repo apply; clears session/checkpoint race fields so callers must not retry `llm_race_apply`
- **Provider circuit** — sync flush when circuit opens; persist errors caught; disk mtime re-sync; read-merge-write preserves other-process open circuits; `restoreProviderCircuitPersistenceState` clears in-memory map
- **Dream audit** — all `appendDreamAudit` paths wrapped; B7 GK dedup uses batch-wide promoted index
- **Pipeline trace persist** — `updateTrace` failures surface in `PipelineResult.warnings`; OTel export awaited and exporter rebuilt when config hash changes
- **Race MCP** — `cleanupErrors` no longer sets `isError` on successful apply/abort
- **Pipeline hooks async** — `onPipelineEnd` / `onPipelineFailed` awaited on all MCP paths

### Changed

- **MCP error responses** — all tools return JSON `{ error, prefix? }` with `isError: true` on failure (machine-parseable). Pipeline `isError` now includes `max_rounds`; pause states (`awaiting_*`) remain `isError: false` — parse `PipelineResult.status` in the JSON body.
- **`llm_query_traces`** — `legacy=true` restores pre-3.0 list shape `{ traces, count, stats? }` without `format` wrapper
- **`orchestration.memoryHybridRetrieve`** — now strict opt-in (`true` required); default off even for layered Mem0/Zep/http backends (G5).
- **Docs layout** — `docs/{guides,architecture,features,operations,reference,history}/` + [docs/README.md](docs/README.md); slim [ROADMAP.md](ROADMAP.md); Phase 0–8 detail in [docs/history/roadmap-delivered-phases.md](docs/history/roadmap-delivered-phases.md)
- **Examples / issues layout** — `examples/configs/`, `examples/workshop/`; `issues/open/`, `issues/archive/` + [issues/README.md](issues/README.md)
- Repo hygiene: `tests/{unit,e2e,integration,federation}/`, A2A under `src/experimental/a2a/`, config types in `src/core/a2a-config-types.ts` + `config-validate.ts`, module splits (`pipeline-runner-helpers`, `http-transport-federation-routes`, etc.)
- Real-provider smoke: Gemini delegate argv auto `-y -p`, Codex/Gemini precheck in `run-real-provider-smoke.ts`

### Added

- `src/tools/mcp-response.ts` — shared MCP JSON/error helpers for all `llm_*` tools
- `npm run clean:test-traces`, `tests/helpers/repo-root.ts`, [`docs/guides/testing.md`](docs/guides/testing.md)

## [3.0.0] - 2026-05-29

### Added

- **Open source (MIT)** — `LICENSE`, [`docs/reference/OPEN_SOURCE.md`](docs/reference/OPEN_SOURCE.md), [`docs/reference/differentiation.md`](docs/reference/differentiation.md)
- **`npm run demo`** — zero API key mock pipeline with trace + experiment output
- **Coding-agent backends guide** — Codex, Gemini, Claude Code, OpenCode via `cli` provider ([`docs/guides/coding-agent-backends.md`](docs/guides/coding-agent-backends.md))
- **`examples/configs/cli.config.json`** — template for real CLI providers
- **`pipeline run` CLI** — `scripts/ts/dev/pipeline-cli.ts` for non-IDE runs (see `npm run pipeline:run`)
- **DeerFlow-style reflect (MVP)** — `orchestration.reflect` on review failure / step failure ([`docs/features/deerflow-reflect.md`](docs/features/deerflow-reflect.md))
- **Dream / Dreamify / memory production** — offline workers + MCP tools (see `docs/features/dream.md`, `docs/features/dreamify.md`, `docs/features/memory-production.md`)
- **Local observability** — `llm_query_traces`, `llm_query_experiments` ([`docs/features/observability.md`](docs/features/observability.md))
- **`loadConfigFromPath()`** — load config from arbitrary path (demo / CLI)

### Changed

- Phase 0–8 + Backlog B2–B8 complete; orchestrator path via `AgentStepRunner` → `executePipelineStep`
- README emphasizes repo-native pipelines vs generic agent frameworks (incl. AutoGen comparison)

### Notes

- Runtime uses **tsx**; `npx tsc --noEmit` may report historical debt — see [CONTRIBUTING.md](CONTRIBUTING.md)
- Docker / devcontainer not provided; requires Node 20+, Python 3, Git locally

[3.0.0]: https://github.com/your-org/runoff/releases/tag/v3.0.0
