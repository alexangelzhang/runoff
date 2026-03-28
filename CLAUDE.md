# CLAUDE.md — llm-pipeline project instructions

## Token Efficiency Rules

### File Reading
- NEVER read `src/index.ts` in full — use Grep to locate the target section, then Read with `offset`+`limit`
- For any file > 200 lines, Grep first, Read the specific range
- After editing, verify with Grep (pattern match) instead of re-reading the whole file
- Don't re-read a file that hasn't changed since the last read in the current context

### Search
- Always scope Glob/Grep with `path` parameter — never search from repo root without it
- Use `path: "src"` or `path: "tests"` to avoid hitting node_modules
- Prefer `output_mode: "content"` with `head_limit` over unbounded searches

### Editing
- Prefer Edit (surgical replacement) over Write (full file rewrite)
- Include enough surrounding context in `old_string` to be unique, but not entire functions

## Project Structure

```
src/index.ts           — MCP server entry point, tool registration (~57 lines)
src/tools/run-step.ts  — llm_run_step tool (single step execution)
src/tools/run-pipeline.ts — llm_run_pipeline tool (pipeline orchestration, largest file ~800 lines)
src/tools/race.ts      — llm_race_apply / llm_race_abort tools (race session finalization)
src/tools/show-config.ts — llm_show_config tool
src/tools/query-traces.ts — llm_query_traces tool
src/tools/helpers.ts   — Shared types, serialization helpers, race session registry
src/ipc.ts             — Shared IPC schema (TaskPayload, TaskResult, field manifests)
src/providers/cli.ts   — CLI provider, bridges TS↔Python via JSON files
src/providers/types.ts — LLMRequest, LLMResponse (TextResponse | AgentResponse), ProviderMode
src/workspace.ts       — Session workspace isolation (delegates to Python workspace_manager)
src/state.ts           — Checkpoint save/load/resume, state machine transitions
src/trace.ts           — Execution trace recording and querying
src/config.ts          — Pipeline config loading and validation
src/router.ts          — Complexity scoring and provider routing
src/candidate.ts       — Unified candidate model (code/changes/filesModified)
src/cache.ts           — LRU response cache
src/verdict.ts         — Review verdict parsing
src/paths.ts           — Home/tasks/traces directory resolution
scripts/task_runner.py — Python task execution (subprocess, worktree, patch, lock)
scripts/workspace_manager.py — Centralized workspace backend (worktree, lock, patch apply)
scripts/watcher.sh     — Watcher process for polling task files
```

## Architecture

- TypeScript: MCP tool API, orchestration, routing, retry, candidate state, trace, judge
- Python: subprocess execution, timeout management, diff collection, workspace management (worktree + locking)
- IPC: file-based JSON (`*.task.json` → `*.result.json`), schema in `src/ipc.ts`
- Shared schema enforced by `tests/ipc-schema.test.ts` — adding IPC fields requires updating both sides
- Workspace isolation: Python `workspace_manager.py` owns all physical git worktree ops and cross-process locking

## Testing

- Run all: `npx tsx --test tests/*.test.ts`
- Run single: `npx tsx --test tests/<name>.test.ts`
- 106 tests, smoke tests involve git worktree ops (~10s)
