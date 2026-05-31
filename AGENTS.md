# AGENTS.md — llm-pipeline

Instructions for AI coding agents (Cursor, Claude Code, Codex, etc.) working in this repository.

## What this project is

**llm-pipeline** is an MCP server that orchestrates multi-step LLM/agent workflows over a user repository. The host agent calls MCP tools; this repo implements pipeline execution, not the host UI.

- **Config-driven DAG:** `pipeline.config.json` defines steps, providers, dependencies, retries, routing, orchestration, runtime governance.
- **Split runtime:** TypeScript owns orchestration, state, traces, governance; Python owns subprocess execution and git worktree isolation.
- **IPC contract:** CLI providers write `*.task.json` / read `*.result.json`; schema must stay in sync between `src/ipc.ts` and `scripts/python/task_runner.py`.

## Before you change code

1. Read [ROADMAP.md](ROADMAP.md) — Phase 0–8 + Backlog B2–B8 done. **Current Runtime**: Config → `agent-graph.ts` → Orchestrator → `AgentStepRunner` → `PipelineStepAgent` → `step-execution.ts`. Industry alignment: [docs/industry-benchmark.md](docs/industry-benchmark.md); refresh pins: `./scripts/refresh-benchmark-pins.sh`.
2. Prefer **surgical edits**; do not rewrite large files wholesale.
3. For files **> 200 lines**, use Grep to locate symbols, then Read with `offset`/`limit` (do not load entire `src/tools/run-pipeline.ts` unless necessary).
4. Scope searches: `path: "src"` or `path: "tests"`, not repo root (avoids `node_modules`).

## Build & verify

```bash
npm install
npm test                    # full suite
npm run check-ipc-sync      # required after src/ipc.ts changes
npx tsc --noEmit
npm run ci:gates            # ipc-sync + gate2 + gate3 + all tests
```

Smoke tests use real git worktrees (~10s). Orchestration smoke: `npx tsx --test tests/orchestration.smoke.test.ts`.

## Architecture (where to edit)

```
Host MCP client
    → src/index.ts (register tools only)
    → src/tools/run-pipeline.ts (MCP llm_run_pipeline; keep thin — extract new logic)
    → src/orchestration/pipeline-execution.ts (plan gate, AgentGraph compile)
    → src/orchestration/pipeline-runner.ts (DAG loop, step-runner, governance hooks)
    → src/scheduler.ts (single-step execution, races)
    → src/providers/* (OpenAI, CLI, mock)
    → scripts/python/task_runner.py + workspace_manager.py (worktree, lock, patch)
```

**Execution layer rules:** see [docs/execution-layers.md](docs/execution-layers.md). Do not implement worktree/lock logic in TypeScript beyond delegating to Python.

**Main pipeline path (no legacy runner):**

`runPipelineExecution` → `compileAgentGraphFromPipeline` → `createAndGatePlan` → `runPipelineDAGLoop` with `agentGraph` / `executionPlan` + `stepRunner` + `orchestrator`.

## MCP tools (do not rename without migration plan)

| Tool | Module |
|------|--------|
| `llm_run_pipeline` | `src/tools/run-pipeline.ts` |
| `llm_run_step` | `src/tools/run-step.ts` |
| `llm_show_config` | `src/tools/show-config.ts` |
| `llm_query_traces` | `src/tools/query-traces.ts` |
| `llm_query_experiments` | `src/tools/query-experiments.ts`（本地 A/B，`docs/observability.md`） |
| `llm_race_apply` / `llm_race_abort` | `src/tools/race.ts` |

New tools: add `src/tools/<name>.ts` and register in `src/index.ts`.

## Common tasks → files

| Goal | Files |
|------|--------|
| New MCP tool | `src/tools/*.ts`, `src/index.ts` |
| Pipeline orchestration | `src/orchestration/pipeline-execution.ts`, `pipeline-runner.ts`, `orchestrator.ts` |
| AgentGraph (B7) | `src/orchestration/agent-graph.ts` |
| Step execution (B8) | `src/orchestration/step-execution.ts`, `pipeline-step-agent.ts`, `step-runner.ts` |
| A2A federation sync (B5) | `src/orchestration/a2a/federation-sync.ts` |
| Orchestrator plan waves | `src/orchestration/plan-scheduler.ts` |
| Single-step / race execution | `src/scheduler.ts`, `src/race-execution.ts` |
| Provider routing / retry pick | `src/router.ts`, `src/retry-strategy.ts` |
| IPC schema | `src/ipc.ts` + `scripts/python/task_runner.py` → `npm run check-ipc-sync` |
| Workspace / worktree | `src/workspace.ts`, `scripts/python/workspace_manager.py` |
| Checkpoints / status machine | `src/state.ts` |
| Traces / query | `src/trace.ts`, `src/tools/query-traces.ts` |
| Policy / approval / guardrails | `src/orchestration/policy.ts`, `approval.ts`, `execution-governance.ts`, `guardrails.ts`, `guardrail-scan.ts` |
| Agent registry | `src/orchestration/agent.ts`, `registry.ts`, `agent-state.ts` |
| A2A HTTP / federation | `src/orchestration/a2a/*`, `federated-registry-store.ts` |
| OTel export | `src/trace-exporter.ts`, `src/pipeline-hooks.ts` |
| Config validation | `src/config.ts` |
| Python executor | `scripts/python/task_runner.py` |

## Hard constraints (breaking these fails CI or production)

1. **IPC sync:** Any change to `src/ipc.ts` field manifests / schema version must mirror `scripts/python/task_runner.py`. Run `npm run check-ipc-sync`.
2. **No mock provider removal** — tests depend on `type: "mock"`.
3. **`run-pipeline.ts` size** — Do not add >50 lines of new feature logic inline; extract to `src/orchestration/` or `src/tools/` helpers.
4. **Workspace isolation** — Physical git ops only in `workspace_manager.py`; TS calls workspace APIs, does not reimplement locks.
5. **`typescript` is a runtime dependency** — `src/ast_utils.ts` uses the compiler API for `isSyntaxValid`; keep it in `dependencies`, not only devDependencies.
6. **Governance order:** Policy → Guardrails → Approval in `ExecutionGovernance.beforeStep` / `afterStep`. Race `awaiting_judge` must be handled **before** `orchestrator.onStepComplete` in `pipeline-runner.ts` (see smoke tests).
7. **Guardrails:** When `runtime.governance.enabled`, extended guardrails default on (secrets, PII, injection, paths). Document new toggles in `docs/governance-config.md`.

## Provider integration

1. Implement `LLMProvider` in `src/providers/types.ts` shape.
2. Register in `src/config.ts` `createProvider()`.
3. Add tests under `tests/` (mock or stub).
4. Sample config snippet in `pipeline.config.json` or docs.

For CLI-backed agents, use `src/providers/cli.ts` and extend Python runner only when IPC fields change.

Reference subagent spec: [.claude/agents/provider-integrator.md](.claude/agents/provider-integrator.md).

## Orchestration modes (`orchestration.mode`)

| Mode | Class | Notes |
|------|--------|------|
| `dag` (default) | `DAGOrchestrator` | Deterministic waves from pipeline DAG |
| `workflow` | `WorkflowOrchestrator` | Parallel stages via workflow agents |
| `llm-driven` | `LLMOrchestrator` | `plannerProvider` + `applyExecutionPlanToAgentGraph` |

## Testing conventions

- Runner: `node --import tsx --test tests/<file>.test.ts`
- Gate e2e: `tests/gate2-control-plane.e2e.test.ts`, `tests/gate3-orchestrator.e2e.test.ts`
- Guardrails: `tests/guardrails-extended.test.ts`, `tests/execution-governance.test.ts`
- After governance / runner changes, run at least `tests/orchestration.smoke.test.ts`

Only add tests that assert real behavior; avoid trivial “construct-only” tests.

## Documentation to keep in sync

When changing behavior, update the smallest relevant doc:

- User-facing: [README.md](README.md)
- Agents: this file
- Governance: [docs/governance-config.md](docs/governance-config.md)
- Roadmap / backlog: [ROADMAP.md](ROADMAP.md)

## What not to do

- Force-push, amend commits, or change git config unless the user explicitly asks.
- Introduce new npm dependencies without strong reason.
- Duplicate DAG rules in `task_runner.py`.
- Treat ROADMAP **Phase 0–8 + Backlog B2–B8** as done; steps run via `PipelineStepAgent` → `executePipelineStep`（`ExecutionScheduler` 类已移除）。新工作见 ROADMAP [Phase 9+](ROADMAP.md#phase-9-plus)（`ROADMAP.md` 内一节，非独立文件）。

## Related agent instructions

- [CLAUDE.md](CLAUDE.md) — token efficiency and Claude-specific search rules (complements this file).
