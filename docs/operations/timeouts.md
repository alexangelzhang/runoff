# Timeouts

Pipeline and provider layers use several independent timeout knobs. They are **not** unified into one global setting.

## Pipeline run (MCP / `llm_run_pipeline`)

| Layer | Default | Location |
|-------|---------|----------|
| **Global pipeline** | 30 minutes | `GLOBAL_TIMEOUT_MS` in `src/tools/run-pipeline.ts` — aborts the whole run and tears down background work |
| **Per-step CLI** | Mode-specific (`getResultTimeoutMs`) | `src/providers/cli.ts`; override per provider via `providers[].timeoutMs` in config |

If the global timeout fires, the client receives an error mentioning `GLOBAL_TIMEOUT_MS`.

## Python task runner

Task files written under `~/.runoff/tasks/` are executed by `scripts/python/task_runner.py`. Step timeout is passed from the CLI provider (`timeoutMs` on the task payload). See `src/ipc.ts` / IPC schema for the field name on the wire.

## Workspace lock

Repo-level locks in `scripts/python/workspace_manager.py` wait up to **120s** by default before raising `REPO_LOCK_TIMEOUT` (includes `repo`, `waited_ms`, `lock_dir`). TypeScript surfaces this in workspace create/resume errors.

## Memory / HTTP clients

Optional `timeoutMs` on memory backends (Mem0, Zep, HTTP memory, pattern-cache hybrid retrieve, OTEL export, A2A registry). Defaults are typically 8–12s unless documented on the config type in `src/core/config.ts`.

## Operational guidance

- Long codegen steps: raise `providers[].timeoutMs` for the slow backend, not only the global 30m cap.
- Stuck repo: check for another pipeline using the same `workDir`; run `npm run runoff:doctor -- --cleanup-orphans` if worktrees were left behind after a crash.
- CI smoke: pre-release profile uses real CLIs; ensure runner timeout (workflow `timeout-minutes`) exceeds worst-case smoke duration.
