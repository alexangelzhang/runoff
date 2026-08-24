# Repository root files

> What belongs at repo root vs what should stay local-only.

## Required (committed)

| Path | Role |
|------|------|
| `pipeline.config.json` | Default pipeline config SoT (`loadConfig()` when no override) |
| `package.json` / `package-lock.json` | Node deps and npm scripts |
| `tsconfig.json` | TypeScript compile options |
| `config/otel-collector-config.yaml` | OTLP collector config for local/pre-release observability |
| `docker-compose.observability.yml` | Optional local stack (Jaeger + collector); see [operations/observability-collector-local.md](operations/observability-collector-local.md) |
| `examples/` | Sample `pipeline.config.json` profiles and observation fixtures |
| `issues/` | Public engineering backlog pointers (not runtime data) |
| `skill/SKILL.md` | MCP host skill snippet for runoff tools |

## Dot-directories

| Path | Policy |
|------|--------|
| `.git/` | Git metadata (never delete) |
| `.github/` | CI workflows and PR template (committed) |
| `.devcontainer/` | Optional reproducible dev env (committed; see [operations/devcontainer.md](operations/devcontainer.md)) |
| `.claude/` | Local agent/hooks config — **gitignored**, do not commit |
| `.codex/` | Local Codex agent config — **gitignored** |
| `.cursor/` | Local Cursor project state — **gitignored** |
| `.venv/` | Python venv — **gitignored** (never commit; use `python3 -m venv .venv` locally) |
| `.vscode/` | IDE settings — **gitignored** |
| `.playwright-mcp/` | Browser MCP debug logs — **gitignored** |
| `.pytest_cache/` | Pytest cache — **gitignored** |

Do **not** delete `.devcontainer/` or `.github/` to “clean” the tree; they are intentional. Ephemeral caches (`.pytest_cache/`, `__pycache__/`, `tmp/`) are safe to remove locally. **Do not** commit test probes under `tmp/` — use `tests/fixtures/` instead.

## Local-only paths (never commit)

| Path | Why |
|------|-----|
| `~/.runoff/` | Runtime home: traces, sessions, checkpoints, control-plane |
| `data/sessions/` | Developer session notes / scratch (repo keeps `data/sessions/.gitkeep` only) |
| `node_modules/` | Install via `npm install` |
| `.venv/` | Python deps for `task_runner.py` / workspace scripts |
| `tests/.tmp-traces-*` | Test temp dirs |

If these were accidentally committed, remove from git index (keep local files):

```bash
git rm -r --cached .venv .playwright-mcp data/sessions/*.md __pycache__ .vscode 2>/dev/null || true
```

## Not at root

- Runtime data: `~/.runoff/` (traces, federation registry, L2 cache, harness evolution artifacts)
- Test artifacts: `tests/.tmp-traces-*` (gitignored; `npm run clean:test-traces`)
