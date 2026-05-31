# Scripts layout

| Directory | Purpose |
|-----------|---------|
| `python/` | IPC task runner + git worktree manager |
| `shell/` | Watcher, health, benchmark pin refresh |
| `ts/ci/` | Contract checks and CI gate runner |
| `ts/dev/` | `pipeline-cli`, demo, real-provider smoke |

Resolve paths from TypeScript via `src/core/paths.ts` (`getTaskRunnerScriptPath`, `getWorkspaceManagerScriptPath`).

Full map: [`docs/architecture/structure.md`](../docs/architecture/structure.md).
