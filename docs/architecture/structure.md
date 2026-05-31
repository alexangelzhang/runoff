# Repository layout

## `dist/` — build output only

`npm run build` (`tsc`) mirrors `src/` into `dist/` with the same relative paths. **Do not hand-organize `dist/`**; change `src/` and rebuild.

```
src/index.ts  →  dist/index.js
```

## `scripts/` — by runtime role

| Directory | Role | Files |
|-----------|------|--------|
| `python/` | Subprocess execution + git worktrees (IPC with TS) | `task_runner.py`, `workspace_manager.py` |
| `shell/` | Long-running ops / watcher / health | `watcher.sh`, `health.sh`, `otel-collector.sh`, `pre-release-otel-gate.sh` |
| `ts/ci/` | CI gates, contract checks | `check-ipc-sync.ts`, `run-ci-gates.ts`, `verify-lease-audit-bundle.ts` |
| `ts/dev/` | Local demos and CLI entrypoints | `demo-quickstart.ts`, `pipeline-cli.ts`, `run-real-provider-smoke.ts` |

Resolve paths via `src/core/paths.ts` (`getTaskRunnerScriptPath`, `getWorkspaceManagerScriptPath`) — not string literals scattered in callers.

## `src/` — TypeScript layers

```
src/
  index.ts                 # MCP entry (register tools only)
  core/                    # Config, IPC, state, paths, pipeline-run-types, candidate, verdict
  infra/                   # ast_utils (typescript compiler at runtime)
  runtime/                 # workspace, workdir policy, race registry/execution
  routing/                 # router, cache, pricing, retry, circuit breaker
  observability/           # trace, experiment log, datasets, OTel export, UI helpers
  memory/                  # pipeline memory, dream state, backend status
  pipeline/                # hooks, CLI trace/observability, real-provider smoke runner
  providers/               # LLM / CLI / mock providers
  tools/                   # MCP tool handlers (thin); re-export PipelineParams from core
  orchestration/           # DAG, agents, governance, durable CP, agent-graph
  experimental/a2a/      # A2A federation (experimental)
  dream/ / dreamify/       # Offline workers
  prompts/                 # Static prompt templates
```

### `src/pipeline/`

CLI-facing helpers that are not MCP tools: `pipeline-hooks.ts`, `trace-cli.ts`, `observability-ui-server.ts`, `run-outcome-hints.ts`, `real-provider-smoke-runner.ts`.

### `src/experimental/a2a/`

Federation sync, leases, HTTP transport (`http-transport-federation-routes.ts`), CRDT registry.

### Rules

- **MCP tools** (`src/tools/`) stay thin; orchestration lives under `src/orchestration/`.
- **Pipeline run types** live in `src/core/pipeline-run-types.ts` — orchestration must not import `src/tools/helpers.ts` for types.
- **Python bridge** only through `src/runtime/workspace.ts` + `src/providers/cli.ts` using `core/paths.ts` script helpers.
- **No new top-level `src/*.ts`** except `index.ts` — add modules under the layer directories above.

## `tests/` — layout

| Directory | Contents |
|-----------|----------|
| `tests/unit/` | Fast unit tests (default bulk of suite) |
| `tests/e2e/` | Gate2/gate3, orchestration smoke, watcher smoke |
| `tests/integration/` | Real-provider integration, phase8, memory-sdk |
| `tests/federation/` | A2A / federation lease and sync tests |
| `tests/fixtures/` | Committed test assets (lock probes, etc.) |

Run all: `npm test` (`tests/**/*.test.ts`). Layout: [`testing.md`](guides/testing.md). Ephemeral trace dirs: `tests/.tmp-traces-*` (gitignored); clean with `npm run clean:test-traces`. Repo scratch: `tmp/` (gitignored) — smoke reports, local only.

## `issues/` — tracked follow-ups

Ad-hoc investigation notes and smoke failures (not product specs). Index: [issues/README.md](../../issues/README.md) · open items: [issues/OPEN-BACKLOG.md](../../issues/OPEN-BACKLOG.md). Prefer ROADMAP / docs for planned work.

## `examples/` — config templates

Pipeline config samples under [examples/configs/](../../examples/configs/). CI: `npm run check:examples-experimental`. See [examples/README.md](../../examples/README.md).

## Migration notes

- Tests may import `../src/<layer>/<file>.ts` (tsx) or `.js` (compiled).
- After moving a module, run `npm test` and `npm run check-ipc-sync`.
