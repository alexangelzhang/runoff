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
| `shell/` | Long-running ops / watcher / health | `watcher.sh`, `health.sh`, `start.sh`, `refresh-benchmark-pins.sh` |
| `ts/ci/` | CI gates, contract checks | `check-ipc-sync.ts`, `check-benchmark-pins.ts`, `run-ci-gates.ts`, `verify-lease-audit-bundle.ts` |
| `ts/dev/` | Local demos and CLI entrypoints | `demo-quickstart.ts`, `pipeline-cli.ts`, `run-real-provider-smoke.ts` |

Resolve paths via `src/core/paths.ts` (`getTaskRunnerScriptPath`, `getWorkspaceManagerScriptPath`) — not string literals scattered in callers.

## `src/` — TypeScript layers

```
src/
  index.ts                 # MCP entry (register tools only)
  core/                    # Config, IPC, state, paths, candidate, verdict, logger
  infra/                   # ast_utils (typescript compiler at runtime)
  runtime/                 # workspace, workdir policy, race registry/execution
  routing/                 # router, cache, pricing, retry, circuit breaker
  observability/           # trace, experiment log, datasets, prompt versions
  memory/                  # pipeline memory, dream state, backend status
  pipeline/                # hooks, prompt composer, real-provider smoke runner
  providers/               # LLM / CLI / mock providers
  tools/                   # MCP tool handlers (thin)
  orchestration/           # DAG, agents, governance, durable CP (existing)
  dream/ / dreamify/       # Offline workers (existing)
  prompts/                 # Static prompt templates (existing)
```

### Rules

- **MCP tools** (`src/tools/`) stay thin; orchestration lives under `src/orchestration/`.
- **Python bridge** only through `src/runtime/workspace.ts` + `src/providers/cli.ts` using `core/paths.ts` script helpers.
- **No new top-level `src/*.ts`** except `index.ts` — add modules under the layer directories above.

## Migration notes

- Tests may import `../src/<layer>/<file>.ts` (tsx) or `.js` (compiled).
- After moving a module, run `npm test` and `npm run check-ipc-sync`.
