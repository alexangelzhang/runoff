---
name: dev-pipeline
description: "llm-pipeline MCP v3 — multi-step code pipelines, traces, memory, dream, race mode, and agent graph"
---

# Dev Pipeline Skill

You orchestrate **llm-pipeline** (MCP server v3.0). The host calls MCP tools; this skill tells you **which tool when**.

**First action on every session:** `llm_show_config` — providers, pipeline steps, routing, memory backend, dreamify state.

**Setup (human):** `npm run setup:mcp -- --host cursor` · [docs/guides/mcp-host-setup.md](../docs/guides/mcp-host-setup.md)

---

## Decision tree

```
What does the user want?
│
├─ Run / change code in a repo
│   ├─ Full DAG (implement → review → retry)     → llm_run_pipeline
│   ├─ One step only                             → llm_run_step
│   ├─ Parallel providers + judge                → llm_run_pipeline (mode: race)
│   │       then pause                           → llm_race_apply | llm_race_abort
│   └─ Resume after approval / checkpoint        → llm_run_pipeline (sessionId + approvalDecision)
│
├─ Understand or edit configuration
│   ├─ Current config summary                    → llm_show_config
│   └─ Agent graph (JSON / Mermaid / HTML)       → llm_show_agent_graph
│
├─ Debug a run
│   ├─ List / inspect traces                     → llm_query_traces
│   ├─ Score a trace (human eval)                → llm_score_trace
│   └─ A/B experiments / eval report             → llm_query_experiments
│
├─ Memory & learning
│   ├─ Backend status (+ optional remote probe)    → llm_memory_status (probe=true)
│   ├─ Search patterns / lessons                 → llm_query_memory
│   ├─ Offline evolution (batch)                 → llm_dream_run
│   ├─ Tune retrieval hyperparams                → llm_dreamify_tune
│   └─ Export memory for external ingest         → llm_dream_export
│
└─ Unsure                                       → llm_show_config, then ask user goal
```

---

## Tier 1 — Onboarding (first run)

1. `llm_show_config` — confirm providers (mock vs CLI vs API).
2. `llm_run_pipeline` with a small prompt and `workDir` pointing at the target repo.
3. If mock: no API keys needed. For real CLI agents see [docs/guides/coding-agent-backends.md](../docs/guides/coding-agent-backends.md).

Example configs: [examples/configs/](../examples/configs/) · scaffold: `npm run pipeline:init -- --work-dir <dir> --profile feature`

---

## Tier 2 — Operator (debug & observability)

| Tool | When to use |
|------|-------------|
| `llm_query_traces` | Find runs by status/time; `traceId` for one run; `format=postmortem` on failures |
| `llm_score_trace` | Record numeric quality score → `~/.llm-pipeline/traces/scores.jsonl`; read back via `llm_query_traces traceId=<id> format=postmortem` → `humanScores` |
| `llm_query_experiments` | A/B variants; `format=eval-report` for winner recommendation |
| `llm_memory_status` | Before enabling Mem0/Zep; `probe=true` checks remote reachability |
| `llm_query_memory` | Hybrid search (local + remote); ops/debug — **not** the hot pipeline read path |
| `llm_dream_run` | After several runs — offline ADD/UPDATE/FORGET on `~/.llm-pipeline/memory/` |
| `llm_dreamify_tune` | After experiments exist — tune semantic threshold / decay / limits |
| `llm_dream_export` | Export jsonl for manual external knowledge-base ingest |

Enable `orchestration.dream.promoteGlobalKnowledge: true` to promote approved-run trace insights into `lesson` memory (Dream rule B7).

Hot-path remote pattern search requires `orchestration.memoryHybridRetrieve: true` (default off).

Memory architecture: [docs/architecture/memory-layers.md](../docs/architecture/memory-layers.md)

---

## MCP response contract

| Outcome | `content[0].text` | `isError` |
|---------|-------------------|-----------|
| Success | JSON payload | false / omitted |
| Exception / validation | JSON `{ "error": "…", "prefix": "…" }` | true |
| Pipeline terminal failure | JSON `PipelineResult` with `status` `failed`, `aborted`, or `max_rounds` | true |
| Pipeline pause (resume needed) | JSON `PipelineResult` with `status` `awaiting_*` | false |
| Step config error | JSON `{ "status": "error", "reason": "…" }` | true |
| Race partial cleanup | JSON result with non-empty `cleanupErrors` | false — inspect `cleanupErrors` in body |

Non-JSON exceptions: `llm_show_agent_graph` with `format=mermaid|html|editor|canvas` returns raw text/HTML (not JSON).

Hosts must parse JSON body fields (`status`, `error`, `reason`, `cleanupErrors`) — **`isError` alone is not sufficient** for pipeline/step/race semantics.

---

## Tier 3 — Config author (graph & governance)

| Tool | When to use |
|------|-------------|
| `llm_show_agent_graph` | Export compiled graph; `format=editor` / `canvas` for visualization |
| `llm_run_pipeline` | `approvalDecision` when checkpoint status is `awaiting_approval` |
| `llm_run_step` | Single step with cache; avoid for `builtin` steps (handled by host) |

Orchestration modes (`orchestration.mode`): `dag` (default) · `workflow` · `llm-driven`.

Governance order: Policy → Guardrails → Approval. See [docs/architecture/governance-config.md](../docs/architecture/governance-config.md).

---

## All MCP tools (14)

| Tool | Purpose |
|------|---------|
| `llm_run_pipeline` | Full pipeline: DAG, retry, routing, cache, approval resume |
| `llm_run_step` | Single configured step |
| `llm_show_config` | Config, providers, routing, cache stats, memory/dreamify summary |
| `llm_show_agent_graph` | AgentGraph export / patch / editor / canvas |
| `llm_query_traces` | Trace query, postmortem, aggregates |
| `llm_score_trace` | Persist trace score |
| `llm_query_experiments` | Local A/B log |
| `llm_memory_status` | Memory backend describe + optional probe |
| `llm_query_memory` | `retrieveMerged` hybrid search |
| `llm_dream_run` | Offline Dream worker (A/B/C tracks) |
| `llm_dreamify_tune` | Retrieval hyperparameter grid search |
| `llm_dream_export` | Export memory jsonl |
| `llm_race_apply` | Apply winning race candidate to repo |
| `llm_race_abort` | Abort race, cleanup workspaces |

---

## Execution modes

### Pipeline (default)

Sequential / parallel stages per `pipeline.config.json`. Review step can trigger retry (`retry.maxRounds`).

```
llm_run_pipeline(prompt: "...", workDir: "/abs/path/to/repo")
```

### Race mode

Multiple providers in parallel; pipeline pauses for judge; finalize with race tools.

```
llm_run_pipeline(prompt: "...", mode: "race")
# after judge selects winner:
llm_race_apply(sessionId: "...")
# or:
llm_race_abort(sessionId: "...")
```

---

## Smart routing & cache

- **Routing:** complexity → provider (`routing` rules in config).
- **Cache:** identical prompt + provider → cached response (TTL ~30min, LRU 64). Stats in `llm_show_config`.

---

## CLI helpers (not MCP)

| Command | Purpose |
|---------|---------|
| `npm run pipeline:doctor -- --config …` | Config + provider health |
| `npm run pipeline:init -- --work-dir … --profile mock\|feature\|…` | Scaffold `pipeline.config.json` |
| `npm run clean:test-traces` | Remove `tests/.tmp-traces-*` |

---

## Do not

- Call `llm_run_step` for steps marked `builtin` in config (host-native agents).
- Assume remote memory (Mem0/Zep) is read on the hot pipeline path — hooks use **local sync**; use `llm_query_memory` for hybrid.
- Skip `llm_race_apply` / `llm_race_abort` after race mode — workspaces stay open until finalized.

---

## Docs hub

- [docs/README.md](../docs/README.md)
- [docs/guides/getting-started-30min.md](../docs/guides/getting-started-30min.md)
- [ROADMAP.md](../ROADMAP.md) · open items [issues/OPEN-BACKLOG.md](../issues/OPEN-BACKLOG.md)
