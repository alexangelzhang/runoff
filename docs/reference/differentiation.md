# Why llm-pipeline?

> **One line:** Multi-step **code-change pipelines** for coding agents — git worktree isolation, provider races, local traces — not another chat-loop framework.

## Who this is for

Teams that already use **Claude Code, Codex CLI, Gemini CLI, OpenCode**, or any MCP-capable host, and need:

- A **declarative DAG** (implement → review → retry) instead of a single agent turn
- **Real-repo** edits with worktree isolation and locks
- **Local** trace + A/B experiment logs without LangSmith SaaS
- Optional **multi-provider race** on the same step

## Five differentiators

### 1. Repo-native delivery (not message-native)

| llm-pipeline | Typical agent framework |
|--------------|-------------------------|
| `agent-write` / `agent-read` on a git worktree | State / messages as primary artifact |
| `workspace_manager.py` — worktree + cross-process lock | Sandboxes vary; rarely this IPC contract |
| `llm_race_apply` / `llm_race_abort` — judge then merge winner | Provider race + pause is **uncommon** |

**Evidence:** `scripts/python/workspace_manager.py`, `src/tools/race.ts`, `industry-benchmark.md` §1.2.

### 2. Config-first pipeline (SoT = JSON)

- **`pipeline.config.json`** defines steps, deps, providers — no Python graph boilerplate required.
- Runtime **compiles** to `AgentGraph` (`compileAgentGraphFromPipeline`) for waves and LLM reflect.
- Parallel stages and dynamic step inject (bounded) stay **code-pipeline** semantics.

**Evidence:** `src/config.ts`, `src/orchestration/agent-graph.ts`.

### 3. Host-agnostic: MCP orchestrates, CLI agents execute

```
  Cursor / Claude Desktop / Claude Code / …  (MCP host)
                    │
                    ▼
            llm-pipeline (DAG, governance, trace)
                    │
                    ▼
     Codex / Gemini / OpenCode / custom CLI  (cli provider → task_runner.py)
                    │
                    ▼
              git worktree in target repo
```

Swapping the coding agent = change **`providers`** in config. The pipeline layer stays.

See [`coding-agent-backends.md`](guides/coding-agent-backends.md).

### 4. Observability on the main path (no observability SaaS required)

- `PipelineHooks` → traces + `experiments.jsonl` (`experimentId` = `hashPrompt(prompt)`).
- MCP: `llm_query_traces`, `llm_query_experiments`, eval export.
- Optional OTLP (`runtime.otelExport`) — off by default.

**Evidence:** `docs/features/observability.md`, `src/pipeline-hooks.ts`.

### 5. Production-shaped control (not demo loops)

- Governance: Policy → Guardrails → Approval.
- Checkpoint / resume; `awaiting_judge`; plan approval gate.
- Durable RunStore / EventLog (`runtime.controlPlane: "file"`).
- Narrow **reflect → re-plan** on review failure / step failure (`docs/features/deerflow-reflect.md`).

---

## Comparison matrix (strategic)

| Capability | llm-pipeline | LangGraph | CrewAI | AutoGen | OpenHands |
|------------|:------------:|:---------:|:------:|:-------:|:---------:|
| Declarative config DAG (JSON) | ✅ | code-first | Crew/Task | code-first | UI + agent |
| Git worktree + lock contract | ✅ | — | — | — | partial |
| Provider race + judge pause | ✅ | — | — | — | — |
| MCP tool surface for IDE hosts | ✅ | optional | MCP (recent) | — | different |
| Local trace + experiment eval | ✅ | +LangSmith | DIY | DIY | partial |
| Conversational multi-agent chat | — | graph | ✅ core | ✅ core | ✅ |
| Self-hosted code-agent focus | ✅ | general | general | general | ✅ |

**Legend:** ✅ = first-class on main path; — = not the product focus (may exist elsewhere).

### AutoGen (Microsoft)

- **Strength:** Group chat, human-in-the-loop patterns, Azure ecosystem.
- **Overlap with us:** Multi-agent orchestration conceptually.
- **Gap vs us:** No `pipeline.config.json` code pipeline, no worktree/race MCP tools, observability is bring-your-own.
- **When to pick AutoGen:** Research-style agent dialogue, Microsoft stack integration.
- **When to pick us:** Repeatable **repo change** workflows with audit trail and config-driven DAG.

### LangGraph

- **Strength:** Stateful graphs, checkpointing, `interrupt()`, large ecosystem.
- **Gap vs us:** Python graph authoring; no built-in race/worktree MCP layer for coding CLIs.
- **When to pick LangGraph:** Complex arbitrary state machines in Python.
- **When to pick us:** IDE/MCP-attached **code delivery** pipelines.

### CrewAI

- **Strength:** Role/goal/task mental model, fast multi-agent prototypes.
- **Gap vs us:** Not centered on git-isolated code execution + race finalize.
- **When to pick CrewAI:** Business process agents with roles.
- **When to pick us:** Engineering teams shipping patches under review loops.

### OpenHands

- **Strength:** Autonomous software engineering agent, repo interaction.
- **Closest competitor** in “code in repo” space.
- **Gap vs us:** Configurable multi-step DAG, provider race, experiment log, MCP-first integration for arbitrary hosts.
- **When to pick OpenHands:** Single autonomous agent UX.
- **When to pick us:** **Composable pipeline** you control (steps, providers, governance).

---

## What we are not

- Not a hosted multi-tenant SaaS
- Not a LangSmith / Langfuse replacement UI
- Not a visual graph editor (Config remains SoT)
- Not Docker-first (bring Node 20+, Python 3, Git)

---

## Slogan options (external)

1. *DAG orchestration for repo changes, not chat loops.*
2. *Race your providers, review in the pipeline, keep traces at home.*
3. *The MCP layer between your IDE and your coding-agent CLIs.*

---

## Related docs

- [`coding-agent-backends.md`](guides/coding-agent-backends.md) — Codex, Gemini, Claude Code, OpenCode
- [`industry-benchmark.md`](reference/industry-benchmark.md) — pinned SHA tactical refs
- [`OPEN_SOURCE.md`](reference/OPEN_SOURCE.md) — release checklist
- [`observability.md`](features/observability.md) — trace + experiment
