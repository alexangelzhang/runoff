# Contributing

Thanks for helping improve **llm-pipeline** — a repo-native, MCP-first code pipeline (not a generic chat-agent framework). See [`docs/differentiation.md`](docs/differentiation.md).

## Prerequisites

- **Node.js** 20+
- **Python** 3
- **Git** (required for smoke tests and `agent-write` worktrees)

```bash
npm install
```

## Before you open a PR

```bash
npm run ci:gates
```

This runs IPC sync check, gate2/gate3 e2e tests, and the full unit suite (~700+ tests).

Optional (when touching CLI providers):

```bash
npm run smoke:real   # requires env vars — see docs/real-provider-smoke.md
```

## Quick local verification

```bash
npm run demo          # mock pipeline, no API keys
npm test              # full suite
npm run check-ipc-sync   # after changing src/ipc.ts or scripts/python/task_runner.py
```

## Project layout

| Area | Path |
|------|------|
| MCP tools | `src/tools/` |
| Orchestration | `src/orchestration/` |
| Providers | `src/providers/` |
| Python executor | `scripts/python/task_runner.py`, `scripts/python/workspace_manager.py` |
| Tests | `tests/` |

## IPC changes

If you modify `src/ipc.ts`, update `scripts/python/task_runner.py` field manifests and run:

```bash
npm run check-ipc-sync
```

## TypeScript

Production entry uses **tsx** (`npm run dev`, `npm start` after build). `npx tsc --noEmit` is tracked but not fully green yet — fix TS errors when you touch related files.

## Docs

- User-facing: `README.md`, `docs/differentiation.md`, `docs/coding-agent-backends.md`
- Agents editing this repo: `AGENTS.md`, `CLAUDE.md`

## Release (maintainers)

1. Update `CHANGELOG.md`
2. `npm run ci:gates`
3. Tag `v*` → GitHub Release workflow publishes notes

See [`docs/OPEN_SOURCE.md`](docs/OPEN_SOURCE.md).
