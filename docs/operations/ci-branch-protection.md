# CI branch protection (recommended)

## Required checks (always)

| Check | Workflow job | Command |
|-------|--------------|---------|
| **CI Gates** | `gates` | `npm run ci:gates` (ipc-sync, typecheck, gate2/3, `test:ci` serial worktree tests, otel verify, examples experimental check, example doctor) |

PRs can merge when `gates` is green. This does **not** prove real Codex/Gemini CLIs work on the PR runner.

## Optional until runner + secrets are ready

| Check | Workflow job | Command |
|-------|--------------|---------|
| **PR smoke** | `smoke` | `npm run ci:gates:smoke` |

Behavior:

- **No** `LLM_PIPELINE_REAL_CODEX_ARGV_JSON` secret → smoke runs with `--allow-skip` (green if CLIs missing).
- **With** `LLM_PIPELINE_REAL_CODEX_ARGV_JSON` set → CI runs `npm run ci:gates:smoke:strict` (no allow-skip). Runner must still have `codex`/`gemini` on PATH or the job fails.
- **Make smoke required in branch protection** once: (1) self-hosted runner with real CLIs is stable, (2) secrets are set, (3) `smoke` job is green on typical PRs for ~1 week.

## Release (tags `v*`)

| Gate | Job |
|------|-----|
| CI gates | `gates` |
| Real provider pre-release | `pre-release-smoke` (self-hosted, **no** allow-skip) |
| GitHub Release | `release` |

Configured in `.github/workflows/release.yml`.

## Secrets (repository)

- `LLM_PIPELINE_REAL_CODEX_ARGV_JSON`
- `LLM_PIPELINE_REAL_GEMINI_ARGV_JSON`
- Optional: `GEMINI_API_KEY`, `OPENAI_API_KEY`

## Variables (repository, optional)

| Variable | Purpose |
|----------|---------|
| `LLM_PIPELINE_REAL_TIMEOUT_MS` | Real-provider smoke timeout |
| `LLM_PIPELINE_OTEL_ENDPOINT` | Corporate OTLP HTTP URL — pre-release skips local collector download (offline runner) |

## Runner labels

Self-hosted runner must provide:

- `self-hosted`
- `llm-pipeline-real-smoke`
- `codex`, `gemini` on PATH for pre-release / nightly workflows
- **OTel pre-release gate** (one of): `curl` for first-time binary download into `RUNNER_TOOL_CACHE/llm-pipeline-otel`; **or** pre-installed `otelcol-contrib` on PATH; **or** set `LLM_PIPELINE_OTEL_ENDPOINT` to an internal collector

Pre-release runs `bash scripts/shell/pre-release-otel-gate.sh` (strict, no `continue-on-error`). See [`observability-collector-local.md`](operations/observability-collector-local.md).
