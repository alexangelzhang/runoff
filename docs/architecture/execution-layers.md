# Execution layers (ownership)

This documents the four execution surfaces so changes stay in the right place (issue 6.15).

| Layer | Role | Owns |
|-------|------|------|
| **TypeScript MCP / orchestration** (`src/index.ts`, `src/tools/run-pipeline.ts`, `src/orchestration/*`, `step-execution.ts`) | Pipeline rounds, DAG, checkpoints, trace snapshots, routing, timeouts (`AbortSignal`), workspace **lifecycle policy** | When to create/resume/destroy worktrees; when to record traces; provider selection |
| **TypeScript providers** (`src/providers/cli.ts`, `openai.ts`, …) | Single LLM/agent call | Task JSON → subprocess or HTTP; parse responses into `LLMResponse` |
| **Python `task_runner.py`** | Default one-shot executor for `CLIProvider` when no custom `args` | Read `*.task.json`, optional `delegateArgv` (real CLI, stdin=prompt), optional git diff for agent modes, write `*.result.json` atomically |
| **Python `workspace_manager.py` + `watcher.sh`** | Git worktrees, repo locks, patch apply; optional file watcher | Physical worktree paths, `RepoLock` semantics, destroy/apply |

**Do not** duplicate lock or worktree logic in TS beyond calling `workspace_manager.py`. **Do not** put pipeline DAG rules in `task_runner.py`.

**Data flow (default CLI path):** TS writes task → `python3 task_runner.py task result` → runner may run `delegateArgv` or stub → TS reads result.

## Cancellation & global timeout (issue 6.11)

| Layer | Behavior |
|-------|----------|
| **MCP `run-pipeline`** | `AbortController` + `GLOBAL_TIMEOUT_MS`; abort sets `finalStatus: "aborted"` and skips destructive workspace finalize when `signal.aborted` |
| **`CLIProvider` / `executeCliRunnerTask`** | Forwards `req.signal`; on abort or per-task timeout, kills the runner process group (`SIGKILL` on POSIX, `taskkill /F /T` on Windows) |
| **Python runner** | One-shot; no separate daemon — cancellation is owned by the TS parent that spawned `task_runner.py` |

Contract tests: `tests/unit/execution-failure-paths.test.ts` (abort + missing result file).
