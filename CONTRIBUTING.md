# Contributing

Thanks for helping improve **llm-pipeline** — repo-native, MCP-first code pipelines. See [`docs/reference/differentiation.md`](docs/reference/differentiation.md).

## Prerequisites

```bash
npm run check-prereqs   # Node 20+, Python 3, Git
npm install
```

## Before you open a PR

```bash
npm run ci:gates
```

Runs: `check-ipc-sync`, gate2/gate3 e2e, full unit suite, **`npm run typecheck`**.

Optional (CLI providers):

```bash
npm run smoke:real   # see docs/operations/real-provider-smoke.md
```

Use the [PR template](.github/pull_request_template.md) checklist.

## Quick local verification

```bash
npm run demo
npm test
npm run check-ipc-sync   # after src/core/ipc.ts or scripts/python/task_runner.py
```

Test layout: [`docs/guides/testing.md`](docs/guides/testing.md).

## Where to change what

| Change | Read first | Path |
|--------|------------|------|
| IPC schema | Field manifests must match | `src/core/ipc.ts`, `scripts/python/task_runner.py` |
| Worktree / locks | Ownership diagram | [`docs/architecture/execution-layers.md`](docs/architecture/execution-layers.md) |
| MCP tool surface | Keep tools thin | `src/tools/` → logic in `src/orchestration/` or layers |
| New pipeline feature | Layer map | [`docs/architecture/structure.md`](docs/architecture/structure.md) |
| Config / DAG | Declaration SoT | `src/core/config.ts`, `pipeline.config.json` |

**Do not** add large blocks to `src/tools/run-pipeline.ts` — register only; implement under `src/orchestration/pipeline-mcp-run.ts` or related modules.

## IPC changes

Update both sides and run:

```bash
npm run check-ipc-sync
```

## TypeScript

- Dev/runtime: **tsx** (`npm run dev`)
- CI: **`npm run typecheck`** (`tsc --noEmit`) must pass
- Production build: `npm run build` → `dist/`

## `issues/` directory

Short-lived notes (smoke failures, triage, close-out checklists). Not a substitute for `ROADMAP.md` or `docs/`. Index: [`issues/README.md`](issues/README.md) · open: [`issues/OPEN-BACKLOG.md`](issues/OPEN-BACKLOG.md).

## `examples/` directory

Config templates in [`examples/configs/`](examples/configs/) (see [`examples/README.md`](examples/README.md)). Do not enable experimental flags in example configs — CI enforces via `check:examples-experimental`.

## Docs

- Users: `README.md`, `docs/guides/getting-started-30min.md`, `docs/reference/differentiation.md`
- Layout: [`docs/architecture/structure.md`](docs/architecture/structure.md)
- Agents: `AGENTS.md`, `CLAUDE.md`
- Security: `docs/architecture/security-model.md`

## Release (maintainers)

See [`docs/operations/release-workflow-template.md`](docs/operations/release-workflow-template.md) and [`docs/reference/OPEN_SOURCE.md`](docs/reference/OPEN_SOURCE.md).

1. `CHANGELOG.md`
2. `npm run ci:gates`
3. `npm run smoke:real:pre-release` (when CLI backends claimed)
4. Tag `v*` → GitHub Release workflow
