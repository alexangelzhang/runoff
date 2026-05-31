# Real Provider Smoke Runner Checklist

This checklist is for bringing up a dedicated self-hosted runner for real provider smoke jobs.
Use it before enabling the nightly workflow or wiring the pre-release gate into a release pipeline.

## 1. Runner shape

- Use a dedicated self-hosted runner with labels `self-hosted` and `llm-pipeline-real-smoke`.
- Keep it isolated from general CI runners so Codex/Gemini login state and CLI versions stay stable.
- Grant the runner a writable workspace with enough disk for repo clones, smoke sandboxes, and uploaded artifacts.

## 2. Required software

Install and verify these tools on the runner host:

- Node.js 22.x
- npm
- git
- codex CLI
- gemini CLI
- **OTel collector gate** (pick one):
  - `curl` — first pre-release run downloads `otelcol-contrib` into `$RUNNER_TOOL_CACHE/llm-pipeline-otel` (cached afterward), **or**
  - `otelcol-contrib` / `otelcol` on PATH (e.g. package install on the runner), **or**
  - Repository variable `LLM_PIPELINE_OTEL_ENDPOINT` pointing at your company OTLP HTTP collector (no local install; best for offline / no-GitHub runners)

Recommended validation commands:

```bash
node --version
npm --version
git --version
codex --version
gemini --version
```

## 3. Auth and secrets

Repository-level secrets/vars expected by the workflows:

- `LLM_PIPELINE_REAL_CODEX_ARGV_JSON`
- `LLM_PIPELINE_REAL_GEMINI_ARGV_JSON`
- `OPENAI_API_KEY` if the chosen Codex invocation needs it
- `GEMINI_API_KEY` if Gemini CLI needs it
- `LLM_PIPELINE_REAL_TIMEOUT_MS` as an optional repository variable

Recommended argv values:

```json
["codex","exec","--full-auto","--skip-git-repo-check"]
```

```json
["gemini","-y","-p"]
```

If Codex or Gemini relies on a local login session instead of API keys, finish that login on the runner host first and re-check `codex --version` / `gemini --version` under the runner account.

## 4. Local validation on the runner host

From a fresh checkout of this repo:

```bash
npm ci
npm run build
npm test
npm run pre-release:otel-gate
npm run smoke:real
```

Expected result:

- `npm run smoke:real` passes even without real provider secrets because manual mode allows skip
- a report is created under `tmp/real-provider-smoke/...`

Before turning on strict gates, validate with real provider env configured:

```bash
npm run smoke:real:nightly
npm run smoke:real:pre-release
```

Expected result:

- no skipped cases
- `summary.md` shows `passed`
- artifact upload contains `summary.json`, `summary.md`, and `diagnostics/`

## 5. GitHub workflow wiring

Workflows currently in repo:

- `.github/workflows/real-provider-smoke-nightly.yml`
- `.github/workflows/real-provider-smoke-pre-release.yml`

Operational recommendation:

- enable `nightly` first and watch a few green runs
- then call the `pre-release` workflow from a release pipeline, or use it as a required manual gate before tagging/releasing

## 6. Failure triage

When a run fails, inspect artifacts in this order:

1. `summary.md`
2. `logs/stdout.log` and `logs/stderr.log`
3. `diagnostics/<case-id>/repo-diff.patch`
4. `diagnostics/<case-id>/home-snapshots/{traces,sessions,tasks}/`

If the failure is provider-environment related, verify CLI login state, PATH, and the JSON shape of `LLM_PIPELINE_REAL_CODEX_ARGV_JSON` / `LLM_PIPELINE_REAL_GEMINI_ARGV_JSON` first.

