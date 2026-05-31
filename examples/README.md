# Examples

> Pipeline config templates and optional workshop code. Index only — configs live under `configs/`.

## Config templates (`configs/`)

Copy into your target repo as `pipeline.config.json`, or scaffold with `npm run pipeline:init`.

| File | Use case | Providers |
|------|----------|-----------|
| [quickstart.config.json](configs/quickstart.config.json) | `npm run demo` | mock |
| [feature.config.json](configs/feature.config.json) | implement → review | mock |
| [bugfix.config.json](configs/bugfix.config.json) | diagnose → fix → review | mock |
| [refactor.config.json](configs/refactor.config.json) | analyze → refactor (race) → review | mock |
| [cli.config.json](configs/cli.config.json) | Real coding-agent CLIs | codex, gemini, … |

```bash
cp examples/configs/cli.config.json /path/to/your-repo/pipeline.config.json
npm run pipeline:config:edit -- --config /path/to/your-repo/pipeline.config.json
```

CI checks all `examples/configs/*.config.json` for experimental flags (`npm run check:examples-experimental`).

## Workshop (`workshop/`)

Optional local exercise (not used by `npm run demo`):

| File | Purpose |
|------|---------|
| [math_processor.ts](workshop/math_processor.ts) | Sync sample target for agent refactor demos |
| [run_exercise.ts](workshop/run_exercise.ts) | Ad-hoc script calling `runPipelineMode` (run from repo root) |

## Docs

- [getting-started-30min.md](../docs/guides/getting-started-30min.md)
- [mock-to-real-cli.md](../docs/guides/mock-to-real-cli.md)
- [coding-agent-backends.md](../docs/guides/coding-agent-backends.md)
