# Execution layers (ownership)

This documents the four execution surfaces so changes stay in the right place (issue 6.15).

| Layer | Role | Owns |
|-------|------|------|
| **TypeScript MCP / orchestration** (`src/index.ts`, `src/tools/run-pipeline.ts`, `src/orchestration/*`, `src/scheduler.ts`) | Pipeline rounds, DAG, checkpoints, trace snapshots, routing, timeouts (`AbortSignal`), workspace **lifecycle policy** | When to create/resume/destroy worktrees; when to record traces; provider selection |
| **TypeScript providers** (`src/providers/cli.ts`, `openai.ts`, …) | Single LLM/agent call | Task JSON → subprocess or HTTP; parse responses into `LLMResponse` |
| **Python `task_runner.py`** | Default one-shot executor for `CLIProvider` when no custom `args` | Read `*.task.json`, optional `delegateArgv` (real CLI, stdin=prompt), optional git diff for agent modes, write `*.result.json` atomically |
| **Python `workspace_manager.py` + `watcher.sh`** | Git worktrees, repo locks, patch apply; optional file watcher | Physical worktree paths, `RepoLock` semantics, destroy/apply |

**Do not** duplicate lock or worktree logic in TS beyond calling `workspace_manager.py`. **Do not** put pipeline DAG rules in `task_runner.py`.

**Data flow (default CLI path):** TS writes task → `python3 task_runner.py task result` → runner may run `delegateArgv` or stub → TS reads result.
