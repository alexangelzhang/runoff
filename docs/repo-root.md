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

## Dot-directories

| Path | Policy |
|------|--------|
| `.git/` | Git metadata (never delete) |
| `.github/` | CI workflows and PR template (committed) |
| `.devcontainer/` | Optional reproducible dev env (committed; see [operations/devcontainer.md](operations/devcontainer.md)) |
| `.claude/` | Local agent/hooks config — **gitignored**, do not commit |
| `.venv/` | Python venv — **gitignored** |
| `.vscode/` | IDE settings — **gitignored** (use personal settings or recommend extensions in CONTRIBUTING) |
| `.pytest_cache/` | Pytest cache — **gitignored** |

Do **not** delete `.devcontainer/` or `.github/` to “clean” the tree; they are intentional. Ephemeral caches (`.pytest_cache/`, `__pycache__/`, `tmp/`) are safe to remove locally. **Do not** commit test probes under `tmp/` — use `tests/fixtures/` instead.

## Not at root

- Runtime data: `~/.runoff/` (traces, federation registry, L2 cache)
- Test artifacts: `tests/.tmp-traces-*` (gitignored; `npm run clean:test-traces`)
