# Why runoff?

> **One line:** A local **coding-agent harness/runtime** — config DAG, git worktree isolation, durable run control, provider races, schema-versioned observations, local traces — not another chat-loop framework.

## Who this is for

Teams that already use **Claude Code, Codex CLI, Gemini CLI, OpenCode**, or any MCP-capable host, and need:

- A **declarative DAG** (implement → review → retry) instead of a single agent turn
- **Real-repo** edits with worktree isolation and locks
- **Observation-shaped results** so MCP hosts continue from a clean work-memory summary instead of raw logs
- A **queryable control plane** for active runs, pending approvals, resume tokens, and event cursors
- **Local** trace + A/B experiment logs without LangSmith SaaS
- Optional **multi-provider race** on the same step

## Six differentiators

### 1. Repo-native delivery (not message-native)

| runoff | Typical agent framework |
|--------------|-------------------------|
| `agent-write` / `agent-read` on a git worktree | State / messages as primary artifact |
| `workspace_manager.py` — worktree + cross-process lock | Sandboxes vary; rarely this IPC contract |
| `runoff_race_apply` / `runoff_race_abort` — judge then merge winner | Provider race + pause is **uncommon** |

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
            runoff (DAG, governance, trace)
                    │
                    ▼
     Codex / Gemini / OpenCode / custom CLI  (cli provider → task_runner.py)
                    │
                    ▼
              git worktree in target repo
```

Swapping the coding agent = change **`providers`** in config. The pipeline layer stays.

See [`coding-agent-backends.md`](guides/coding-agent-backends.md).

### 4. Observation-shaped results (not raw tool dumps)

- `PipelineResult.observation` gives hosts a stable run-level summary: status, evidence, coverage gaps, next action, trace/checkpoint refs.
- `StepResult.observation` gives step-local evidence and artifact refs without inlining full diffs or logs.
- `artifacts` and `traces` remain the audit trail; observations are work memory for the next agent turn.

**Evidence:** `src/orchestration/observation.ts`, `docs/features/observability.md` §Observation layer.

### 5. Observability on the main path (no observability SaaS required)

- `PipelineHooks` → traces + `experiments.jsonl` (`experimentId` = `hashPrompt(prompt)`).
- MCP: `runoff_query_traces`, `runoff_query_experiments`, eval export.
- Optional OTLP (`runtime.otelExport`) — off by default.

**Evidence:** `docs/features/observability.md`, `src/pipeline-hooks.ts`.

### 6. Production-shaped control (not demo loops)

- Governance: Policy → Guardrails → Approval.
- Checkpoint / resume; `awaiting_judge`; plan approval gate.
- Durable RunStore / EventLog (`runtime.controlPlane: "file"`) plus `runoff_query_runs` for run status, pending approvals, resume hints, and event cursors.
- Narrow **reflect → re-plan** on review failure / step failure (`docs/features/deerflow-reflect.md`).

---

## Comparison matrix (strategic)

### Tier 1: Same-category tools (coding agent orchestrators — real competition)

Verified 2026-06 via AnySearch + page extract.

| Capability | runoff | Vibe Kanban | projd | Cadence |
|------------|:------:|:-----------:|:-----:|:-------:|
| Declarative config (JSON/YAML) | ✅ JSON DAG | — (UI kanban) | ✅ JSON feature files | ✅ YAML profile |
| Git worktree isolation | ✅ | ✅ | ✅ | ✅ (v7.11+) |
| Parallel agents | ✅ | ✅ | ✅ up to 20 | ✅ multi-PR |
| **Same-task provider race** | ✅ **core** | — (diff tasks) | — (review PRs) | — (diff phases) |
| Observation-shaped MCP result | ✅ | — | — | — |
| Human judge + pick winner | ✅ | — | ✅ (review PR) | — |
| **Learn from judge picks** | ✅ Dream/Dreamify | — | — | — |
| Multi-provider support | 4 CLIs | Claude/Codex/Gemini/Copilot | Claude-first | 16+ providers |
| Local trace + experiment eval | ✅ | — | TUI dashboard | — |
| MCP tool surface for IDE hosts | ✅ | — | — | — |
| Smoke-test / lint gates | ✅ | — | ✅ enforced | ✅ validate phase |
| Risk-tiered review depth | — | — | — | ✅ low/medium/high |
| Stars (2026-06) | 0 (early) | **26.8k** | early | active v8+ |

**Legend:** ✅ = first-class on main path; — = not the product focus.

**Key finding:** worktree isolation and parallel execution are **table stakes** in 2026 — every tool has them. runoff's unique atom: **same-task provider race → human judge → learn from picks**. No tier-1 competitor does all three.

### How the tier-1 tools differ from runoff

#### Vibe Kanban (BloopAI, 26.8k ★)

- **What it is:** Visual kanban board for spawning parallel agents, each in its own worktree.
- **Model:** Different agents work on **different tasks** in parallel; you watch a dashboard.
- **Gap vs us:** No same-task race, no pick-winner mechanic, no learning from outcomes. Visual UI, not config-file-driven.
- **When to pick Vibe Kanban:** You want a visual dashboard to run many parallel tasks fast.
- **When to pick runoff:** You want to know which AI writes the *best* code for *one* task, and you want the system to remember your taste over time.

#### projd (0spoon)

- **What it is:** JSON feature files + worktree isolation + dependency-wave dispatch + PreToolUse guardrails + TUI dashboard.
- **Model:** Single agent (Claude) builds features in dependency order; you review the resulting PRs.
- **Closest overlap:** Declarative JSON config and "you review" mechanic feel similar — but projd is single-provider dispatch, runoff is multi-provider competition.
- **Gap vs us:** No same-task race across providers. No cross-run learning.
- **When to pick projd:** You want guardrails + phased dispatch without provider comparison.
- **When to pick runoff:** You want to pit two providers against each other on the same prompt and learn from the winner.

#### Cadence (v8.4)

- **What it is:** Multi-model SDLC harness — different models for different phases (write/review/triage/council), YAML config, 16+ providers, risk-tiered review depth.
- **Model:** Different models do **different SDLC roles** (author ≠ reviewer). Not racing — dividing.
- **Closest overlap:** YAML-as-SoT pipeline config and multi-provider support. Both fight the single-model blind-spot problem — from different angles (role-split vs same-task race).
- **Gap vs us:** Different phases, not same-phase race. No trace-grounded cross-run learning.
- **When to pick Cadence:** Full SDLC pipeline with role-differentiated models.
- **When to pick runoff:** Run the *same step* on N providers and have the system learn your quality preferences over time.

### Tier 2: General orchestration frameworks

| Capability | runoff | LangGraph | CrewAI | AutoGen | OpenHands |
|------------|:------:|:---------:|:------:|:-------:|:---------:|
| Declarative config DAG (JSON) | ✅ | code-first | Crew/Task | code-first | UI + agent |
| Git worktree + lock contract | ✅ | — | — | — | partial |
| Provider race + judge pause | ✅ | — | — | — | — |
| MCP tool surface for IDE hosts | ✅ | optional | MCP (recent) | — | different |
| Observation-shaped result | ✅ | DIY | DIY | DIY | partial |
| Local trace + experiment eval | ✅ | +LangSmith | DIY | DIY | partial |
| Conversational multi-agent chat | — | graph | ✅ core | ✅ core | ✅ |
| Self-hosted code-agent focus | ✅ | general | general | general | ✅ |

#### AutoGen (Microsoft)

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
