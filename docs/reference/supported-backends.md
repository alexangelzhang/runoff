# Supported coding-agent backends

Backends listed here passed **`npm run smoke:real:pre-release`** on the project's self-hosted runner before the matching release tag.

## Matrix

Pre-release smoke **must pass** all case IDs (see `PRE_RELEASE_REQUIRED_CASE_IDS` in `src/pipeline/real-provider-smoke-runner.ts`):

| Case ID | Scenario |
|---------|----------|
| `codex-standalone` | Codex agent-write implement + mock review |
| `gemini-standalone` | Gemini agent-write implement + mock review |
| `provider-race` | Codex + Gemini race → `awaiting_judge` (defer finalize) |
| `provider-race-autopick` | Same race with `runtime.raceFinalize: auto-pick` → `approved` |

| Backend | Smoke profile | Last pre-release pass | Notes |
|---------|---------------|----------------------|--------|
| Codex CLI | cases above | _Update on release_ | `LLM_PIPELINE_REAL_CODEX_ARGV_JSON` |
| Gemini CLI | cases above | _Update on release_ | `LLM_PIPELINE_REAL_GEMINI_ARGV_JSON` |

Mock-only pipelines do not require this matrix.

## Maintainer workflow

1. Run `npm run smoke:real:pre-release` on the self-hosted runner (or let the Release workflow run it on tag).
2. Update the **Last pre-release pass** column with the date (UTC) and tag (e.g. `v3.0.1`).
3. Copy the smoke report artifact path into `CHANGELOG.md` for that version if useful.

See [real-provider-smoke.md](operations/real-provider-smoke.md) and [release-publish-checklist.md](operations/release-publish-checklist.md).
