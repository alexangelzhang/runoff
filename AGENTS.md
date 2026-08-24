# AGENTS.md — runoff

Instructions for AI coding agents (Cursor, Claude Code, Codex, etc.) working in this repository.

## What this project is

**runoff** is an MCP server that orchestrates multi-step LLM/agent workflows over a user repository. The host agent calls MCP tools; this repo implements pipeline execution, not the host UI.

- **Config-driven DAG:** `pipeline.config.json` defines steps, providers, dependencies, retries, routing, orchestration, runtime governance.
- **Split runtime:** TypeScript owns orchestration, state, traces, governance; Python owns subprocess execution and git worktree isolation.
- **IPC contract:** CLI providers write `*.task.json` / read `*.result.json`; schema must stay in sync between `src/core/ipc.ts` and `scripts/python/task_runner.py`.

## Before you change code

1. Read [ROADMAP.md](ROADMAP.md) — Phase 0–8 + Backlog B2–B8 done. **Current Runtime**: Config → `agent-graph.ts` → Orchestrator → `AgentStepRunner` → `PipelineStepAgent` → `step-execution.ts`. Industry alignment: [docs/reference/industry-benchmark.md](docs/reference/industry-benchmark.md); refresh pins: `./scripts/refresh-benchmark-pins.sh`.
2. Prefer **surgical edits**; do not rewrite large files wholesale.
3. For files **> 200 lines**, use Grep to locate symbols, then Read with `offset`/`limit` (do not load entire `src/tools/run-pipeline.ts` unless necessary).
4. Scope searches: `path: "src"` or `path: "tests"`, not repo root (avoids `node_modules`).

## Build & verify

```bash
npm install
npm test                    # full suite
npm run check-ipc-sync      # required after src/core/ipc.ts changes
npx tsc --noEmit
npm run ci:gates            # ipc-sync + gate2 + gate3 + all tests
```

Smoke tests use real git worktrees (~10s). Orchestration smoke: `npx tsx --test tests/e2e/orchestration.smoke.test.ts`.

## Architecture (where to edit)

```
Host MCP client
    → src/index.ts (register tools only)
    → src/tools/run-pipeline.ts (MCP runoff_run_pipeline registration)
    → src/orchestration/pipeline-mcp-run.ts (MCP session / approval resume)
    → src/orchestration/pipeline-execution.ts (plan gate, AgentGraph compile)
    → src/orchestration/pipeline-runner.ts (DAG loop, step-runner, governance hooks)
    → src/orchestration/step-execution.ts (single-step execution, races)
    → src/providers/* (OpenAI, CLI, mock)
    → scripts/python/task_runner.py + workspace_manager.py (worktree, lock, patch)
```

**Execution layer rules:** see [docs/architecture/execution-layers.md](docs/architecture/execution-layers.md). Do not implement worktree/lock logic in TypeScript beyond delegating to Python.

**Main pipeline path (no legacy runner):**

`runPipelineExecution` → `compileAgentGraphFromPipeline` → `createAndGatePlan` → `runPipelineDAGLoop` with `agentGraph` / `executionPlan` + `stepRunner` + `orchestrator`.

## MCP tools (do not rename without migration plan)

| Tool                                      | Module                           |
| ----------------------------------------- | -------------------------------- |
| `runoff_run_pipeline`                     | `src/tools/run-pipeline.ts`      |
| `runoff_run_step`                         | `src/tools/run-step.ts`          |
| `runoff_show_config`                      | `src/tools/show-config.ts`       |
| `runoff_show_agent_graph`                 | `src/tools/show-agent-graph.ts`  |
| `runoff_query_traces`                     | `src/tools/query-traces.ts`      |
| `runoff_score_trace`                      | `src/tools/score-trace.ts`       |
| `runoff_query_experiments`                | `src/tools/query-experiments.ts` |
| `runoff_memory_status`                    | `src/tools/memory-status.ts`     |
| `runoff_query_memory`                     | `src/tools/query-memory.ts`      |
| `runoff_query_context`                    | `src/tools/query-context.ts`     |
| `runoff_dream_run`                        | `src/tools/dream-run.ts`         |
| `runoff_dreamify_tune`                    | `src/tools/dreamify-tune.ts`     |
| `runoff_dream_export`                     | `src/tools/dream-export.ts`      |
| `runoff_race_apply` / `runoff_race_abort` | `src/tools/race.ts`              |

**MCP response contract:** success and error bodies are JSON in `content[0].text`. Errors use `{ "error", "prefix" }` with `isError: true`. Pipeline/race/step semantics live in JSON fields (`status`, `reason`, `cleanupErrors`) — do not rely on `isError` alone. See `skill/SKILL.md` §MCP response contract.

New tools: add `src/tools/<name>.ts` and register in `src/index.ts`.

## Common tasks → files

| Goal                           | Files                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New MCP tool                   | `src/tools/*.ts`, `src/index.ts`                                                                                                                              |
| Pipeline orchestration         | `src/orchestration/pipeline-execution.ts`, `pipeline-runner.ts`, `orchestrator.ts`                                                                            |
| AgentGraph (B7)                | `src/orchestration/agent-graph.ts`                                                                                                                            |
| Step execution (B8)            | `src/orchestration/step-execution.ts`, `pipeline-step-agent.ts`, `step-runner.ts`                                                                             |
| A2A federation sync (B5)       | `src/experimental/a2a/federation-sync.ts`                                                                                                                     |
| Orchestrator plan waves        | `src/orchestration/plan-scheduler.ts`                                                                                                                         |
| Single-step / race execution   | `src/orchestration/step-execution.ts`, `src/runtime/race-execution.ts`                                                                                        |
| Provider routing / retry pick  | `src/routing/router.ts`, `src/routing/retry-strategy.ts`                                                                                                      |
| IPC schema                     | `src/core/ipc.ts` + `scripts/python/task_runner.py` → `npm run check-ipc-sync`                                                                                |
| Workspace / worktree           | `src/runtime/workspace.ts`, `scripts/python/workspace_manager.py`                                                                                             |
| Checkpoints / status machine   | `src/core/state.ts`                                                                                                                                           |
| Traces / query                 | `src/observability/trace.ts`, `src/tools/query-traces.ts`                                                                                                     |
| Observation summaries          | `src/orchestration/observation.ts`, `src/core/state.ts`, `src/core/pipeline-run-types.ts`                                                                     |
| Harness evolution              | **Split out** to the standalone `agent-evolution` project (host-agnostic `propose → evaluate → accept` loop). Not part of this repo anymore. |
| Policy / approval / guardrails | `src/orchestration/policy.ts`, `approval.ts`, `execution-governance.ts`, `guardrails.ts`, `guardrail-scan.ts`                                                 |
| Agent registry                 | `src/orchestration/agent.ts`, `registry.ts`, `agent-state.ts`                                                                                                 |
| A2A HTTP / federation          | `src/experimental/a2a/*` (shims under `experimental/a2a/`)                                                                                                    |
| OTel export                    | `src/observability/trace-exporter.ts`, `src/pipeline/pipeline-hooks.ts`                                                                                       |
| Config validation              | `src/core/config.ts`                                                                                                                                          |
| Pipeline run types             | `src/core/pipeline-run-types.ts`                                                                                                                              |
| Python executor                | `scripts/python/task_runner.py`                                                                                                                               |

## Hard constraints (breaking these fails CI or production)

1. **IPC sync:** Any change to `src/core/ipc.ts` field manifests / schema version must mirror `scripts/python/task_runner.py`. Run `npm run check-ipc-sync`.
2. **No mock provider removal** — tests depend on `type: "mock"`.
3. **`run-pipeline.ts` size** — Do not add >50 lines of new feature logic inline; extract to `src/orchestration/` or `src/tools/` helpers.
4. **Workspace isolation** — Physical git ops only in `workspace_manager.py`; TS calls workspace APIs, does not reimplement locks.
5. **`typescript` is a runtime dependency** — `src/ast_utils.ts` uses the compiler API for `isSyntaxValid`; keep it in `dependencies`, not only devDependencies.
6. **Governance order:** Policy → Guardrails → Approval in `ExecutionGovernance.beforeStep` / `afterStep`. Race `awaiting_judge` must be handled **before** `orchestrator.onStepComplete` in `pipeline-runner.ts` (see smoke tests).
7. **Guardrails:** When `runtime.governance.enabled`, extended guardrails default on (secrets, PII, injection, paths). Document new toggles in `docs/architecture/governance-config.md`.
8. **Observation layer:** `StepResult.observation` and `PipelineResult.observation` are deterministic, schema-versioned work memory for the next host/model turn. Keep full audit material in `artifacts` / `traces`; do not replace them with summaries.
9. **Harness evolution (extracted):** the harness-evolution control plane was split into the standalone, host-agnostic `agent-evolution` project; runoff no longer imports or depends on it. Its audit-artifact, acceptance, and non-mutation contracts (no automatic repo edits, promotion-export-only, clean proposal + observed diff + audit + held-in/held-out gate required) live in that project's own AGENTS.md. runoff-side artifacts that referenced it (`runoff_query_context` `resolve_route` mode, `pipeline harness …` CLI surface, `getHarnessEvolutionDir`) were removed.

## Provider integration

1. Implement `LLMProvider` in `src/providers/types.ts` shape.
2. Register in `src/config.ts` `createProvider()`.
3. Add tests under `tests/` (mock or stub).
4. Sample config snippet in `pipeline.config.json` or docs.

For CLI-backed agents, use `src/providers/cli.ts` and extend Python runner only when IPC fields change.

Reference subagent spec: [.claude/agents/provider-integrator.md](.claude/agents/provider-integrator.md).

## Orchestration modes (`orchestration.mode`)

| Mode            | Class                  | Notes                                                |
| --------------- | ---------------------- | ---------------------------------------------------- |
| `dag` (default) | `DAGOrchestrator`      | Deterministic waves from pipeline DAG                |
| `workflow`      | `WorkflowOrchestrator` | Parallel stages via workflow agents                  |
| `llm-driven`    | `LLMOrchestrator`      | `plannerProvider` + `applyExecutionPlanToAgentGraph` |

## Testing conventions

- Runner: `npm test` or `node --import tsx --test tests/<subdir>/<file>.test.ts`
- Gate e2e: `tests/e2e/gate2-control-plane.e2e.test.ts`, `tests/e2e/gate3-orchestrator.e2e.test.ts`
- Guardrails: `tests/unit/guardrails-extended.test.ts`, `tests/unit/execution-governance.test.ts`
- After governance / runner changes, run at least `tests/e2e/orchestration.smoke.test.ts`

Only add tests that assert real behavior; avoid trivial “construct-only” tests.

## Documentation to keep in sync

When changing behavior, update the smallest relevant doc:

- User-facing: [README.md](README.md)
- Agents: this file
- Governance: [docs/architecture/governance-config.md](docs/architecture/governance-config.md)
- Roadmap / backlog: [ROADMAP.md](ROADMAP.md)

## What not to do

- Force-push, amend commits, or change git config unless the user explicitly asks.
- Introduce new npm dependencies without strong reason.
- Duplicate DAG rules in `task_runner.py`.
- Treat ROADMAP **Phase 0–8 + Backlog B2–B8** as done; steps run via `PipelineStepAgent` → `executePipelineStep`（`ExecutionScheduler` 类已移除）。未排期项见 ROADMAP [Future](ROADMAP.md#future)；历史 phase 见 [docs/history/roadmap-delivered-phases.md](docs/history/roadmap-delivered-phases.md)。

## Related agent instructions

- [CLAUDE.md](CLAUDE.md) — token efficiency and Claude-specific search rules (complements this file).
