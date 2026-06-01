# Security model (self-hosted)

runoff is a **local orchestrator**. It does not host multi-tenant SaaS. Threat model below is for teams running MCP + CLI on developer machines or CI.

## Trust boundaries

| Boundary | What runs | Trust assumption |
|----------|-----------|------------------|
| MCP host (IDE) | Invokes `llm_run_pipeline` | User trusts the IDE |
| runoff (Node) | DAG, governance, trace | Same user/CI as host |
| `task_runner.py` | Spawns **your** coding-agent CLI | **Executes arbitrary provider command** from config |
| Target git repo | Worktree + patch apply | Repo is the asset to protect |

## Execution surface

- **CLI providers** (`type: "cli"`) run `command` + `args` from `pipeline.config.json` with `cwd` = isolated worktree (or source for read-only modes).
- There is **no** built-in sandbox beyond git worktree isolation and OS user permissions.
- Treat `pipeline.config.json` like code: review before merge, restrict write access in CI.

## Filesystem and locks

- `RUNOFF_HOME` (default `~/.runoff/`): traces, sessions, experiments, checkpoints — may contain prompts and diffs.
- `workspace_manager.py`: cross-process **repo lock** (exclusive by default; shared key only when configured).
- Patches applied via temp files under pipeline home; see [execution-layers.md](architecture/execution-layers.md).

## Network

- Core path: **no** required outbound network except what **your** Codex/Gemini/OpenAI CLI already uses.
- Optional: OTLP export (`runtime.otelExport`), HTTP memory backends, A2A federation HTTP — all **opt-in** in config.

## Secrets

- API keys: environment variables consumed by provider CLIs or `openai` provider — not written to trace by default.
- Governance guardrails can block secret/PII patterns in prompts/responses when `orchestration` governance is enabled ([governance-config.md](architecture/governance-config.md)).

## CI recommendations

- Run pipelines only on trusted branches with locked-down `pipeline.config.json`.
- Do not commit `.env` or provider tokens.
- Prefer mock providers in PR CI (`npm run ci:gates`); use `smoke:real` only on protected runners with secrets ([real-provider-smoke.md](operations/real-provider-smoke.md)).

## Out of scope

- Multi-tenant isolation, RBAC console, OAuth for MCP
- Container hardening (no official Docker image — bring your own if needed)
