# Test fixtures

Committed assets used by unit tests. **Not** runtime scratch — ephemeral dirs belong in `tmp/` (gitignored) or OS temp via `mkdtempSync`.

| Path | Used by |
|------|---------|
| `lock/repo_lock_mp_probe.py` | `tests/unit/concurrency-lock.test.ts` — multiprocessing RepoLock probe |
| `lock/lock_helper.py` | Optional manual lock debugging (spawn helper) |
