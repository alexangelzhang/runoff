## Summary

<!-- What changed and why (repo-native pipeline / IPC / docs)? -->

## Checklist

- [ ] `npm run ci:gates` (or `npm test` + `npm run check-ipc-sync` if IPC touched)
- [ ] If `src/core/ipc.ts` changed → updated `scripts/python/task_runner.py` and ran `npm run check-ipc-sync`
- [ ] If execution/locks/worktrees touched → read [execution-layers.md](../docs/architecture/execution-layers.md)
- [ ] No secrets or `.env` committed
- [ ] New features in `src/tools/` stay thin (logic under `src/orchestration/` or layers per [structure.md](../docs/architecture/structure.md))

## Test plan

<!-- Commands run, e.g. npm test, smoke paths -->
