# runoff Roadmap

> Last updated: 2026-05-26 · **Executive summary only** — Phase 0–8 detail: [docs/history/roadmap-delivered-phases.md](docs/history/roadmap-delivered-phases.md)

## Status at a glance

| Area | State |
|------|--------|
| Phase 0–8 + Backlog B2–B8 | **Delivered** (Gate 1/2/3 passed) |
| CI | `npm run ci:gates` — ipc-sync + gate2 + gate3 + full test suite |
| Tests | ~793 pass, 6 skip (`npm run test:ci`) |
| Open engineering | **[issues/OPEN-BACKLOG.md](issues/OPEN-BACKLOG.md)** — Codex vendor ENOENT on smoke runners (precheck in place) |
| Unscheduled product/tech | **Future** table below (not committed dates) |

**Docs hub:** [docs/README.md](docs/README.md) · **Repo root files:** [docs/repo-root.md](docs/repo-root.md)

---

## Vision (short)

**North Star:** Config compiles to an observable agent graph; Orchestrator controls execution; agents share context, governance, and trace — without replacing `pipeline.config.json` as declaration SoT or the Python worktree/IPC layer.

**Current runtime (verified):**

```
pipeline.config.json → compileAgentGraphFromPipeline → runPipelineExecution
  → AgentRegistry → runPipelineDAGLoop → AgentStepRunner → PipelineStepAgent
  → executePipelineStep → Provider → task_runner.py → workspace_manager.py
```

Anchors: `agent-graph.ts` → `pipeline-execution.ts` → `pipeline-runner.ts` → `step-runner.ts` → `step-execution.ts`.

---

## Delivered (no open phase backlog)

All Phase 0–8 checklist items and B2–B8 are **DONE**. Per-phase notes, dependency graph, quality gates, and industry benchmark tables: **[docs/history/roadmap-delivered-phases.md](docs/history/roadmap-delivered-phases.md)**.

---

## Shipped extensions (pointers)

| Capability | Doc |
|------------|-----|
| Harness control plane | `runoff_query_runs` · `src/orchestration/run-query.ts` · durable RunStore/EventLog status, pending approvals, resume hints, event cursors |
| Harness evolution substrate | `runoff_harness_evolve` · `src/orchestration/harness-evolution.ts` · change manifest, isolated proposer, observed variant diff, held-in/out gate, variant isolation, coreset, self-preference rank, accept/rollback audit |
| Local observability | [docs/features/observability.md](docs/features/observability.md) · `src/observability/trace.ts` · `StepResult.observation` / `PipelineResult.observation` work-memory layer |
| Memory / Dream / Dreamify | [docs/features/memory-production.md](docs/features/memory-production.md), [dream.md](docs/features/dream.md), [dreamify.md](docs/features/dreamify.md) · hot-path formation queue + B6 forget: **shipped**; graph query/export: **Future** in [ROADMAP.md](../ROADMAP.md) |
| Reflect re-plan (MVP) | [docs/features/deerflow-reflect.md](docs/features/deerflow-reflect.md) |
| Open source pack | [docs/reference/OPEN_SOURCE.md](docs/reference/OPEN_SOURCE.md), [differentiation.md](docs/reference/differentiation.md) |
| A2A federation (MVP) | [docs/features/a2a-federation.md](docs/features/a2a-federation.md) · `src/experimental/a2a/` |
| Hooks runtime | [docs/architecture/pipeline-hooks-runtime.md](docs/architecture/pipeline-hooks-runtime.md) |

---

## Future (unscheduled)

Not a commitment backlog — single issues or ROADMAP rows when scoped.

| Theme | Notes | Doc / code |
|-------|--------|------------|
| **Codex smoke env** | `codex` binary missing on some runners; precheck fails fast | [issues/OPEN-BACKLOG.md](issues/OPEN-BACKLOG.md) |
| **Pipeline hooks deepen** | Durable CP + listener ergonomics | [pipeline-hooks-runtime.md](docs/architecture/pipeline-hooks-runtime.md) |
| **A2A federation HA** | Multi-node directory, auth federation, CRDT-style conflict | [a2a-federation.md](docs/features/a2a-federation.md) |
| **AgentGraph viz** | JSON / Mermaid / HTML export polish | `agent-graph-viz.ts` |
| **Orchestration productization** | Thin MCP surface vs internal modules | `pipeline-mcp-run.ts` |
| **Memory graph route** | `entity_relation` 现为扁平 upsert（`trace-entities.ts`），无多跳查询；待做轻量邻域索引 / provider×file 聚合查询层，可选 MCP `llm_query_entity_graph` | [memory-dream-roadmap.md](docs/features/memory-dream-roadmap.md) §2 边界 · `trace-entities.ts` |
| **Memory graph export (M4)** | 可选单向文件导出（如 `lessons.jsonl` / triples NDJSON）供外部 KG（Cognee/vault）人工 ingest — **非实时双写、非 API 耦合** | [memory-dream-roadmap.md](docs/features/memory-dream-roadmap.md) §2 |
| **Industry pins** | `npm run check-benchmark-pins`; refresh quarterly | [benchmark-pins.json](docs/reference/benchmark-pins.json) |

---

## Industry alignment

Strategic + tactical comparison (pinned SHAs): **[docs/reference/industry-benchmark.md](docs/reference/industry-benchmark.md)**.

Refresh pins: `./scripts/shell/refresh-benchmark-pins.sh` · CI warn: `npm run check-benchmark-pins`.

Capability matrix and external references: see [delivered-phases § Industry Benchmarks](docs/history/roadmap-delivered-phases.md#industry-benchmarks).

---

## For contributors

- Layer rules: [docs/architecture/execution-layers.md](docs/architecture/execution-layers.md)
- Layout: [docs/architecture/structure.md](docs/architecture/structure.md)
- Tests: [docs/guides/testing.md](docs/guides/testing.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
