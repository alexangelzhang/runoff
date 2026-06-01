# Stability boundaries (S3.5)

What **runoff** guarantees vs what is **out of scope** for self-hosted MCP usage.

## Guaranteed (main path)

| Area | Boundary |
|------|----------|
| Config DAG + mock providers | Covered by `npm run ci:gates` (~700+ unit tests, serial worktree tests in CI) |
| IPC schema | `npm run check-ipc-sync` on every PR |
| Checkpoint / resume | Same `sessionId` + matching prompt/config hash; not while `awaiting_judge` |
| Repo lock | Single writer per repo root unless `sharedLockKey` (race) |
| Tag release | `.github/workflows/release.yml` requires gates + pre-release real-provider smoke |

## Not guaranteed

| Area | Why |
|------|-----|
| Multi-tenant / multi-writer HA | Single-machine `RepoLock` under `~/.runoff/locks` |
| PR green ⇒ real Codex/Gemini | PR smoke may `allow-skip` until secrets + self-hosted runner |
| Experimental features | A2A federation, Dream, Dreamify — off in `examples/` (see `npm run check:examples-experimental`) |
| Hosted SaaS SLA | MCP + local data only |

## Single-writer semantics

- Default workspace: **exclusive** repo lock for the pipeline session.
- Race mode: participants share `sharedLockKey` (typically `traceId`); still one applying winner at finalize.
- Do not run two unrelated pipelines against the same `workDir` without coordination.

## Related docs

- [ci-branch-protection.md](operations/ci-branch-protection.md)
- [timeouts.md](operations/timeouts.md)
- [supported-backends.md](reference/supported-backends.md)
- [execution-layers.md](architecture/execution-layers.md)
