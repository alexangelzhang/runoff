# Examples

> Pipeline config templates and optional workshop code. Index only — configs live under `configs/`.

## Config templates (`configs/`)

Copy into your target repo as `pipeline.config.json`, or scaffold with `npm run pipeline:init`.

| File | Use case | Providers |
|------|----------|-----------|
| [quickstart.config.json](configs/quickstart.config.json) | `npm run demo` | mock |
| [race-demo.config.json](configs/race-demo.config.json) | `npm run demo:race` — two providers compete | mock-a, mock-b |
| [feature.config.json](configs/feature.config.json) | implement → review | mock |
| [bugfix.config.json](configs/bugfix.config.json) | diagnose → fix → review | mock |
| [refactor.config.json](configs/refactor.config.json) | analyze → refactor (race) → review | mock |
| [pr-babysitter.config.json](configs/pr-babysitter.config.json) | PR babysitter loop — triage → fix → verify → review (L2 governance) | mock |
| [race-pr-babysitter.config.json](configs/race-pr-babysitter.config.json) | PR babysitter + **fix-step provider race** → human judge (`runoff_race_apply`) | mock-a, mock-b |
| [ci-sweeper.config.json](configs/ci-sweeper.config.json) | CI sweeper — triage → diagnose → fix → verify → review (L2) | mock |
| [daily-triage.config.json](configs/daily-triage.config.json) | Daily triage — report-only L1 (single triage step) | mock |
| [cli.config.json](configs/cli.config.json) | Real coding-agent CLIs | codex, gemini, … |

Loop profiles scaffold `AGENTS.md` + `STATE.md`:

```bash
npm run pipeline:init -- --work-dir /path/to/your-repo --profile pr-babysitter
# or: race-pr-babysitter | ci-sweeper | daily-triage
```

Paste Loop Ready badge into README after doctor passes:

```bash
npm run runoff:doctor -- --config /path/to/your-repo/pipeline.config.json --badge
```

```bash
cp examples/configs/cli.config.json /path/to/your-repo/pipeline.config.json
npm run pipeline:config:edit -- --config /path/to/your-repo/pipeline.config.json
```

CI checks all `examples/configs/*.config.json` for experimental flags (`npm run check:examples-experimental`).

## Observation result example

| File | Purpose |
|------|---------|
| [observation-result.json](observation-result.json) | Example `PipelineResult` showing `observation`, step observation, artifact refs, trace refs, and the next host action |

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
- [harness-vs-loop.md](../docs/guides/harness-vs-loop.md) — Harness vs Loop, PR Babysitter pattern, doctor readiness
- [host-loop-cookbook.md](../docs/guides/host-loop-cookbook.md) — cron / MCP / GitHub Actions loop hosting
- [mfs-context-layer.md](../docs/guides/mfs-context-layer.md) — optional MFS + runoff integration
- [observability.md](../docs/features/observability.md)
