---
name: dev-pipeline
description: "runoff MCP v3 — multi-step code pipelines, traces, memory, dream, race mode, and agent graph"
---

# Dev Pipeline Skill

You orchestrate **runoff** (MCP server v3.0). The host calls MCP tools; this skill tells you **which tool when**.

**First action on every session:** `runoff_show_config` — providers, pipeline steps, routing, memory backend, dreamify state.

**Setup (human):** `npm run setup:mcp -- --host cursor` · [docs/guides/mcp-host-setup.md](../docs/guides/mcp-host-setup.md)

---

## Decision tree

```
What does the user want?
│
├─ Run / change code in a repo
│   ├─ Full DAG (implement → review → retry)     → runoff_run_pipeline
│   ├─ One step only                             → runoff_run_step
│   ├─ Parallel providers + judge                → runoff_run_pipeline (mode: race)
│   │       then pause                           → runoff_race_apply | runoff_race_abort
│   └─ Resume after approval / checkpoint        → runoff_run_pipeline (sessionId + approvalDecision)
│
├─ Understand or edit configuration
│   ├─ Current config summary                    → runoff_show_config
│   └─ Agent graph (JSON / Mermaid / HTML)       → runoff_show_agent_graph
│
├─ Debug a run
│   ├─ List active/paused runs                   → runoff_query_runs
│   ├─ List / inspect traces                     → runoff_query_traces
│   ├─ Score a trace (human eval)                → runoff_score_trace
│   └─ A/B experiments / eval report             → runoff_query_experiments
│
├─ Evolve the harness
│   ├─ Select hard/diverse traces                → runoff_harness_evolve(action="coreset")
│   ├─ Create change manifest + variant          → runoff_harness_evolve(action="create")
│   ├─ Propose isolated candidate edits          → runoff_harness_evolve(action="propose")
│   ├─ Run held-in / held-out gate               → runoff_harness_evolve(action="evaluate")
│   └─ Rank / accept / rollback                  → runoff_harness_evolve(action="rank"|"decide")
│
├─ Memory & learning
│   ├─ Backend status (+ optional remote probe)    → runoff_memory_status (probe=true)
│   ├─ Search patterns / lessons                 → runoff_query_memory
│   ├─ Offline evolution (batch)                 → runoff_dream_run
│   ├─ Tune retrieval hyperparams                → runoff_dreamify_tune
│   └─ Export memory for external ingest         → runoff_dream_export
│
└─ Unsure                                       → runoff_show_config, then ask user goal
```

---

## Tier 1 — Onboarding (first run)

1. `runoff_show_config` — confirm providers (mock vs CLI vs API).
2. `runoff_run_pipeline` with a small prompt and `workDir` pointing at the target repo.
3. If mock: no API keys needed. For real CLI agents see [docs/guides/coding-agent-backends.md](../docs/guides/coding-agent-backends.md).

Example configs: [examples/configs/](../examples/configs/) · scaffold: `npm run pipeline:init -- --work-dir <dir> --profile feature`

---

## Tier 2 — Operator (debug & observability)

| Tool | When to use |
|------|-------------|
| `runoff_query_runs` | Check active/paused/failed runs, pending approvals, resume tokens, and latest event cursor |
| `runoff_query_traces` | Find runs by status/time; `traceId` for one run; `format=postmortem` on failures |
| `runoff_score_trace` | Record numeric quality score → `~/.runoff/traces/scores.jsonl`; read back via `runoff_query_traces traceId=<id> format=postmortem` → `humanScores` |
| `runoff_query_experiments` | A/B variants; `format=eval-report` for winner recommendation |
| `runoff_harness_evolve` | Harness evolution substrate: coreset selection, change manifest, isolated proposer with observed variant diff, held-in/out regression gate, pairwise rank, acceptance guard/rollback |
| `runoff_memory_status` | Before enabling Mem0/Zep; `probe=true` checks remote reachability |
| `runoff_query_memory` | Hybrid search (local + remote); ops/debug — **not** the hot pipeline read path |
| `runoff_dream_run` | After several runs — offline ADD/UPDATE/FORGET on `~/.runoff/memory/` |
| `runoff_dreamify_tune` | After experiments exist — tune semantic threshold / decay / limits |
| `runoff_dream_export` | Export jsonl for manual external knowledge-base ingest |

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

Non-JSON exceptions: `runoff_show_agent_graph` with `format=mermaid|html|editor|canvas` returns raw text/HTML (not JSON).

Hosts must parse JSON body fields (`status`, `error`, `reason`, `cleanupErrors`) — **`isError` alone is not sufficient** for pipeline/step/race semantics.

Pipeline results may include `observation`, and completed steps may include `stepResults.<step>.observation`. These deterministic, schema-versioned work-memory summaries carry evidence, coverage gaps, next-action hints, and references back to `artifacts`, checkpoints, and traces. Use them for next-turn reasoning, then inspect artifacts/traces for complete audit material.

Host reading order after `runoff_run_pipeline`: parse JSON → inspect `observation.status` / `observation.nextHint` → inspect relevant `stepResults.<step>.observation` → open referenced `artifacts` or query traces when full evidence is needed. For `awaiting_judge`, follow `observation.nextHint` and then call `runoff_race_apply` or `runoff_race_abort`; for `awaiting_approval`, resume with `approvalDecision`.

---

## Tier 3 — Config author (graph & governance)

| Tool | When to use |
|------|-------------|
| `runoff_show_agent_graph` | Export compiled graph; `format=editor` / `canvas` for visualization |
| `runoff_run_pipeline` | `approvalDecision` when checkpoint status is `awaiting_approval` |
| `runoff_run_step` | Single step with cache; avoid for `builtin` steps (handled by host) |

Orchestration modes (`orchestration.mode`): `dag` (default) · `workflow` · `llm-driven`.

Governance order: Policy → Guardrails → Approval. See [docs/architecture/governance-config.md](../docs/architecture/governance-config.md).

---

## All MCP tools (16)

| Tool | Purpose |
|------|---------|
| `runoff_run_pipeline` | Full pipeline: DAG, retry, routing, cache, approval resume |
| `runoff_run_step` | Single configured step |
| `runoff_query_runs` | Harness control-plane status, approvals, resume hints |
| `runoff_show_config` | Config, providers, routing, cache stats, memory/dreamify summary |
| `runoff_show_agent_graph` | AgentGraph export / patch / editor / canvas |
| `runoff_query_traces` | Trace query, postmortem, aggregates |
| `runoff_score_trace` | Persist trace score |
| `runoff_query_experiments` | Local A/B log |
| `runoff_harness_evolve` | Harness evolution control plane |
| `runoff_memory_status` | Memory backend describe + optional probe |
| `runoff_query_memory` | `retrieveMerged` hybrid search |
| `runoff_dream_run` | Offline Dream worker (A/B/C tracks) |
| `runoff_dreamify_tune` | Retrieval hyperparameter grid search |
| `runoff_dream_export` | Export memory jsonl |
| `runoff_race_apply` | Apply winning race candidate to repo |
| `runoff_race_abort` | Abort race, cleanup workspaces |

---

## Execution modes

### Pipeline (default)

Sequential / parallel stages per `pipeline.config.json`. Review step can trigger retry (`retry.maxRounds`).

```
runoff_run_pipeline(prompt: "...", workDir: "/abs/path/to/repo")
```

### Race mode

Multiple providers in parallel; pipeline pauses for judge; finalize with race tools.

```
runoff_run_pipeline(prompt: "...", mode: "race")
# after judge selects winner:
runoff_race_apply(sessionId: "...")
# or:
runoff_race_abort(sessionId: "...")
```

---

## Smart routing & cache

- **Routing:** complexity → provider (`routing` rules in config).
- **Cache:** identical prompt + provider → cached response (TTL ~30min, LRU 64). Stats in `runoff_show_config`.

---

## CLI helpers (not MCP)

| Command | Purpose |
|---------|---------|
| `npm run runoff:doctor -- --config …` | Config + provider health |
| `npm run runoff:init -- --work-dir … --profile mock\|feature\|…` | Scaffold `pipeline.config.json` |
| `npm run runoff:runs -- list --config …` | List active/paused/failed runs from the durable control plane |
| `npm run runoff:runs -- show <runId> --config …` | Inspect one run's next action, resume token, approval, and event cursor |
| `npm run clean:test-traces` | Remove `tests/.tmp-traces-*` |

---

## Do not

- Call `runoff_run_step` for steps marked `builtin` in config (host-native agents).
- Assume remote memory (Mem0/Zep) is read on the hot pipeline path — hooks use **local sync**; use `runoff_query_memory` for hybrid.
- Skip `runoff_race_apply` / `runoff_race_abort` after race mode — workspaces stay open until finalized.

---

## Docs hub

- [docs/README.md](../docs/README.md)
- [docs/guides/getting-started-30min.md](../docs/guides/getting-started-30min.md)
- [ROADMAP.md](../ROADMAP.md) · open items [issues/OPEN-BACKLOG.md](../issues/OPEN-BACKLOG.md)
