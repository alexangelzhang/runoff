# Industry Benchmark — 战略 + 战术双层对标

> **审计日期：** 2026-05-26  
> **版本钉扎：** [`benchmark-pins.json`](benchmark-pins.json)（可用 `./scripts/refresh-benchmark-pins.sh` 刷新）  
> **关联：** [ROADMAP.md](../ROADMAP.md#vision) Vision（North Star / Current Runtime）、[execution-layers.md](execution-layers.md)

本文档把业界对标拆成两层，避免「只谈概念」或「只扫目录」各说各话：

| 层级 | 英文 | 回答的问题 | 证据形式 |
|------|------|------------|----------|
| **战略** | Strategic / Pattern | 架构分层是否合理？能力是否覆盖？差异化在哪？ | 概念映射、能力矩阵、与 Vision 对齐 |
| **战术** | Tactical / Code | 具体模块/类/入口如何对应？差在哪几个文件？ | **GitHub 路径 + commit SHA** |

---

## 0. 方法论

### 0.1 证据等级

| 等级 | 标记 | 含义 |
|------|------|------|
| E1 | `doc` | 官方文档 / README / AGENTS.md |
| E2 | `code@ref` | 指定 commit 下仓库内源文件路径（本审计默认） |
| E3 | `runtime` | 本仓库测试或 MCP 实测（需单独记录命令） |

ROADMAP 旧版 Industry Benchmarks 多为 **E1 + 归纳**；本节战术表升级为 **E2**。

### 0.2 版本钉扎（本次审计）

| 项目 | Repo | Ref (main) | Date (UTC) |
|------|------|------------|------------|
| **llm-pipeline** | local | `8ef46e624dfb2aaa382722474bac79d67586d20d` | workspace HEAD |
| OpenAI Agents SDK | [openai/openai-agents-python](https://github.com/openai/openai-agents-python) | `6d5b888f6f57b8356398bea883b45172fec54b95` | 2026-05-26 |
| LangGraph | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | `d1e2ff0561a8b0b09212d0795c9d7b390a5de23a` | 2026-05-22 |
| Google ADK | [google/adk-python](https://github.com/google/adk-python) | `7ad7994744de18f2394e4bcb961cd5c7a24afb4b` | 2026-05-22 |
| CrewAI | [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | `bad64b1ee67a2f6279b901292d018248657aafda` | 2026-05-26 |
| DeerFlow | [bytedance/deer-flow](https://github.com/bytedance/deer-flow) | `f68bcb771c01caa53ba4b3dd59b41ebb00d00cfa` | 2026-05-26 |
| AutoGen | [microsoft/autogen](https://github.com/microsoft/autogen) | *(add via refresh-benchmark-pins)* | — |

**AutoGen（战略备注）：** 对话式 multi-agent 见长；与 llm-pipeline **repo-native DAG + worktree/race** 场景正交。用户向对比见 [`differentiation.md`](differentiation.md)。

刷新：`npm run refresh-benchmark-pins`（或 `./scripts/refresh-benchmark-pins.sh`）→ 更新 `benchmark-pins.json` → 复核下文战术表链接中的 SHA。

**CI：** `npm run check-benchmark-pins`（`ci:gates` 默认 warn；`--strict` 在 `auditedAt` 超过 90 天时失败）。

### 0.3 对标范围（刻意排除）

- **Anthropic Claude Agent SDK**：偏 Host 内嵌 loop，不是 DAG 编排平台，仅作 MCP 宿主参考。
- **LangSmith / Phoenix**：观测平台，与 `src/trace.ts` 对标，不纳入编排五层链。
- **Microsoft Agent Framework**：以博客/文档为主（E1），未纳入本次 E2 全量扫描（可下一版补）。

---

## 1. 战略对标（Concept / Pattern）

### 1.1 Vision 五层 — 概念映射

| Vision 层 | 战略职责 | OpenAI Agents SDK | LangGraph | Google ADK | CrewAI | llm-pipeline |
|-----------|----------|-------------------|-----------|------------|--------|--------------|
| **Config** | 声明拓扑与策略 | Examples + agent defs | Graph builder code / YAML | `agent_config` / YAML | Crew `@Crew` 装饰器 | `pipeline.config.json` |
| **AgentGraph** | 运行时图 SoT | 隐式（handoff 链） | **StateGraph** 显式 | Agent 树 + workflow agents | Flow `@router` | `agent-graph.ts`（Config 编译） |
| **Orchestrator** | 控场与恢复 | `run.py` / Runner | `compile()` + `invoke` | `SequentialAgent` / `ParallelAgent` | `Crew.kickoff` / Flow | `orchestrator.ts` + `pipeline-runner.ts` |
| **Agent** | 身份 + 执行体 | `agent.py` | graph **nodes** | `LlmAgent` / `BaseAgent` | `Agent` + `CrewAgentExecutor` | `agent.ts` + `registry.ts` |
| **SharedContext** | 跨步共享状态 | `run_context.py` / session | **Reducer state** | `session.state` | Crew 共享 task 输出 | `shared-context.ts` |

**战略结论：** North Star 五层与主流框架 **同构**；差异在 **代码流水线 + git 隔离 + race**（见 §1.3），不在「是否该有 Orchestrator」。

### 1.2 能力矩阵（战略）

| 维度 | llm-pipeline | 业界典型 | 战略态势 |
|------|--------------|----------|----------|
| DAG / 拓扑执行 | ✅ Config DAG | LangGraph StateGraph, ADK Sequential | 对齐 |
| 并行 wave | ✅ stage 并行 | ADK ParallelAgent, LangGraph 并行 superstep | 对齐 |
| 动态改图 | ✅ 运行时注入 step | LangGraph conditional edges | 对齐 |
| Checkpoint / Resume | ✅ `state.ts` | LangGraph Checkpointer | 对齐；我们偏 pipeline checkpoint |
| Human-in-the-loop | ✅ plan + action approval | LangGraph `interrupt_before`, MS Approval | 对齐 |
| Guardrails | ✅ tripwire 全量 | OpenAI `guardrail.py` | 对齐 |
| Agent 记忆 | ✅ persistent memory | Mem0 / Zep 外置 | 部分对齐（外置深度可选） |
| **Provider race** | ✅ **独有** | 少见 | **差异化** |
| **Git worktree 隔离** | ✅ Python WM | OpenAI sandbox agent（不同模型） | **差异化** |
| **MCP 工具面** | ✅ 主入口 | 各框架可选 MCP | **定位差异** |
| AgentGraph 运行时 SoT | ✅ `agent-graph.ts` | LangGraph 原生 | 对齐（Config 仍为声明 SoT） |
| Orchestrator 控步入口 | ✅ `step-runner.ts` | 节点即执行体 | 对齐（Scheduler 仍承载 race） |
| A2A 联邦生产 | ✅ `federation-sync.ts` | ADK `remote_a2a_agent.py` | 对齐 |

### 1.3 差异化（战略 — 为何不做「纯 AgentGraph」一刀切换）

1. **业务场景**：面向 **仓库内代码变更** 的可审计流水线，不是通用对话图。
2. **工程护城河**：`task_runner.py` + `workspace_manager.py` + race finalize 与编排层正交（见 [execution-layers.md](execution-layers.md)）。
3. **兼容**：Config DAG 仍是用户 SoT；运行时经 **编译/投影** 为 `AgentGraph`（`compileAgentGraphFromPipeline`），不废弃 JSON。

---

## 2. 战术对标（Code @ pinned ref）

链接格式：`https://github.com/{owner}/{repo}/blob/{ref}/{path}`

### 2.1 llm-pipeline 锚点（`8ef46e6`）

| Concern | 路径 |
|---------|------|
| MCP 入口 | `src/index.ts` |
| Pipeline MCP | `src/tools/run-pipeline.ts` |
| Plan gate + 主链 | `src/orchestration/pipeline-execution.ts` |
| DAG 循环 + governance 钩子 | `src/orchestration/pipeline-runner.ts` |
| Orchestrator 实现 | `src/orchestration/orchestrator.ts` |
| Plan → stages | `src/orchestration/plan-scheduler.ts` |
| 单步 / race | `src/scheduler.ts`, `src/race-execution.ts` |
| Agent 模型 | `src/orchestration/agent.ts`, `registry.ts`, `agent-state.ts` |
| SharedContext | `src/orchestration/shared-context.ts`, `context-integration.ts` |
| Policy / Guardrails / Approval | `policy.ts`, `guardrails.ts`, `execution-governance.ts` |
| Checkpoint | `src/state.ts` |
| Durable CP | `durable-run-store.ts`, `durable-event-log.ts`, `run-control.ts` |
| A2A | `src/orchestration/a2a/*` |
| Worktree 执行 | `scripts/python/task_runner.py`, `scripts/python/workspace_manager.py` |

### 2.2 OpenAI Agents SDK (`6d5b888`)

| Concern | 路径 (E2) |
|---------|-----------|
| 运行时入口 | [`src/agents/run.py`](https://github.com/openai/openai-agents-python/blob/6d5b888f6f57b8356398bea883b45172fec54b95/src/agents/run.py) |
| 编排内部 | [`src/agents/run_internal/`](https://github.com/openai/openai-agents-python/tree/6d5b888f6f57b8356398bea883b45172fec54b95/src/agents/run_internal) |
| Agent 定义 | [`src/agents/agent.py`](https://github.com/openai/openai-agents-python/blob/6d5b888f6f57b8356398bea883b45172fec54b95/src/agents/agent.py) |
| Handoff | [`src/agents/handoffs/`](https://github.com/openai/openai-agents-python/tree/6d5b888f6f57b8356398bea883b45172fec54b95/src/agents/handoffs) |
| Guardrails | [`src/agents/guardrail.py`](https://github.com/openai/openai-agents-python/blob/6d5b888f6f57b8356398bea883b45172fec54b95/src/agents/guardrail.py), [`tool_guardrails.py`](https://github.com/openai/openai-agents-python/blob/6d5b888f6f57b8356398bea883b45172fec54b95/src/agents/tool_guardrails.py) |
| Run 状态 | [`src/agents/run_state.py`](https://github.com/openai/openai-agents-python/blob/6d5b888f6f57b8356398bea883b45172fec54b95/src/agents/run_state.py) |
| Tracing | [`src/agents/tracing/`](https://github.com/openai/openai-agents-python/tree/6d5b888f6f57b8356398bea883b45172fec54b95/src/agents/tracing) |
| MCP | [`src/agents/mcp/`](https://github.com/openai/openai-agents-python/tree/6d5b888f6f57b8356398bea883b45172fec54b95/src/agents/mcp) |

**战术映射 → 我们：** `run.py` ≈ `pipeline-execution` + `scheduler`；`guardrail.py` ≈ `guardrails.ts`；handoff ≈ `messages.ts` / A2A（弱同构）。**无** 一等 DAG config；**无** git worktree 层。

### 2.3 LangGraph (`d1e2ff0`)

| Concern | 路径 (E2) |
|---------|-----------|
| StateGraph 构建 | [`libs/langgraph/langgraph/graph/state.py`](https://github.com/langchain-ai/langgraph/blob/d1e2ff0561a8b0b09212d0795c9d7b390a5de23a/libs/langgraph/langgraph/graph/state.py) |
| Checkpointer | [`libs/checkpoint/`](https://github.com/langchain-ai/langgraph/tree/d1e2ff0561a8b0b09212d0795c9d7b390a5de23a/libs/checkpoint) |
| Pregel 执行引擎 | [`libs/langgraph/langgraph/pregel/`](https://github.com/langchain-ai/langgraph/tree/d1e2ff0561a8b0b09212d0795c9d7b390a5de23a/libs/langgraph/langgraph/pregel) |

**战术映射 → 我们：** `StateGraph` ≈ **B7 AgentGraph 目标**；当前 `dag.ts` + `pipeline.config.json` ≈ builder 输入。`compile(checkpointer=)` ≈ `state.ts` + `durable-run-store.ts`。`interrupt_before` ≈ `plan-control.ts` / `execution-governance.ts` defer。

**缺口（战术）：** 无 Pregel 级统一执行器；checkpoint 模型是 pipeline session 而非 graph node 级 reducer（部分重叠）。

### 2.4 Google ADK (`7ad7994`)

| Concern | 路径 (E2) |
|---------|-----------|
| Sequential 编排 | [`src/google/adk/agents/sequential_agent.py`](https://github.com/google/adk-python/blob/7ad7994744de18f2394e4bcb961cd5c7a24afb4b/src/google/adk/agents/sequential_agent.py) |
| Parallel 编排 | [`src/google/adk/agents/parallel_agent.py`](https://github.com/google/adk-python/blob/7ad7994744de18f2394e4bcb961cd5c7a24afb4b/src/google/adk/agents/parallel_agent.py) |
| LLM Agent | [`src/google/adk/agents/llm_agent.py`](https://github.com/google/adk-python/blob/7ad7994744de18f2394e4bcb961cd5c7a24afb4b/src/google/adk/agents/llm_agent.py) |
| 会话上下文 | [`src/google/adk/agents/invocation_context.py`](https://github.com/google/adk-python/blob/7ad7994744de18f2394e4bcb961cd5c7a24afb4b/src/google/adk/agents/invocation_context.py) |
| A2A 远程 Agent | [`src/google/adk/agents/remote_a2a_agent.py`](https://github.com/google/adk-python/blob/7ad7994744de18f2394e4bcb961cd5c7a24afb4b/src/google/adk/agents/remote_a2a_agent.py) |
| LangGraph 互操作 | [`src/google/adk/agents/langgraph_agent.py`](https://github.com/google/adk-python/blob/7ad7994744de18f2394e4bcb961cd5c7a24afb4b/src/google/adk/agents/langgraph_agent.py) |

**战术映射 → 我们：** `SequentialAgent` ≈ `executionPlan` 有序 waves；`ParallelAgent` ≈ parallel stage + `SharedContext`。`remote_a2a_agent` ≈ `a2a/http-transport.ts`（B5 联邦待加强）。**无** -repo worktree 模块。

### 2.5 CrewAI (`bad64b1`)

| Concern | 路径 (E2) |
|---------|-----------|
| Agent 执行器 | [`lib/crewai/src/crewai/agents/crew_agent_executor.py`](https://github.com/crewAIInc/crewAI/blob/bad64b1ee67a2f6279b901292d018248657aafda/lib/crewai/src/crewai/agents/crew_agent_executor.py) |
| Crew 编排 | [`lib/crewai/src/crewai/crew.py`](https://github.com/crewAIInc/crewAI/blob/bad64b1ee67a2f6279b901292d018248657aafda/lib/crewai/src/crewai/crew.py)（路径以 repo 为准） |
| Flow 事件驱动 | [`lib/crewai/src/crewai/flow/`](https://github.com/crewAIInc/crewAI/tree/bad64b1ee67a2f6279b901292d018248657aafda/lib/crewai/src/crewai/flow) |

**战术映射 → 我们：** Role-based `Agent` ≈ `agent.ts` + `multi-agent-types.ts`。Crew process ≈ DAG stages。Flow `@listen` ≈ **部分** `onStepComplete` 回调（不如 Flow 通用）。**无** 内置 code race / worktree。

### 2.6 DeerFlow (`f68bcb7`) — Plan→Execute→Reflect 参考

| Concern | 路径 (E2) |
|---------|-----------|
| 仓库入口 | [`README.md`](https://github.com/bytedance/deer-flow/blob/f68bcb771c01caa53ba4b3dd59b41ebb00d00cfa/README.md) |

**说明：** DeerFlow 基于 LangGraph 组装；战术上应 **复用 LangGraph 节** + 阅读其 planner/coordinator 模块（下一版审计可展开 `src/` 子目录树）。我们 `LLMOrchestrator` + `llm-planner.ts` ≈ 其 plan 阶段（B6 深化项）。

---

## 3. 战略 × 战术 合表（核心 Concern）

| Concern | 战略参考 | 战术参考 (E2 示例) | llm-pipeline (E2) | 态势 |
|---------|----------|-------------------|-------------------|------|
| 图 / DAG 定义 | LangGraph StateGraph | `graph/state.py` | `agent-graph.ts`, `dag.ts`, `config.ts` | 对齐 |
| 执行编排 | ADK Sequential | `sequential_agent.py` | `orchestrator.ts`, `pipeline-runner.ts` | 对齐 |
| 并行 | ADK Parallel | `parallel_agent.py` | `pipeline-runner.ts` + `SharedContext` | 对齐 |
| 检查点 | LangGraph Checkpointer | `libs/checkpoint/` | `state.ts`, `durable-run-store.ts` | 对齐 |
| HITL | LangGraph interrupt | `interrupt_before` 文档 | `plan-control.ts`, `approval-adapters.ts` | 对齐 |
| Guardrails | OpenAI guardrail | `guardrail.py` | `guardrails.ts`, `guardrail-scan.ts` | 对齐 |
| 追踪 | OpenAI tracing | `tracing/` | `trace.ts`, `trace-exporter.ts` | 对齐 |
| Handoff / 消息 | OpenAI handoffs | `handoffs/` | `messages.ts`, `bus.ts` | 部分 |
| A2A | Google A2A | `remote_a2a_agent.py` | `a2a/*`, B5 联邦 | 部分 |
| 代码隔离 | OpenAI sandbox | sandbox 文档 | `workspace_manager.py` | **差异化** |
| Multi-provider race | — | — | `scheduler.ts`, `race.ts` | **独有** |

**图例：** 对齐 = 同等 concern 有明确模块；部分 = 有类似能力但模型不同；独有/差异化 = 业界少见或实现路径不同。

---

## 4. 维护流程

1. **季度或 Major 发布前：** 运行 `./scripts/refresh-benchmark-pins.sh`。
2. **抽样复核：** 每个框架选 2 个 concern（编排入口 + 状态/检查点）打开 GitHub 链接，确认路径未漂移。
3. **更新矩阵：** 修改本节战术表「路径」列与 [ROADMAP.md](../ROADMAP.md) Industry Benchmarks 的「态势」列。
4. **可选 E3：** 在 `tests/gate3-orchestrator.e2e.test.ts` 旁增加「能力探针」清单（不替代 E2）。

---

## 5. 与 ROADMAP 的关系

- **战略：** Vision North Star 与 Backlog B2–B8 已对齐落地。
- **战术：** `agent-graph.ts`、`step-execution.ts`、`PipelineStepAgent`、`federation-sync.ts` 为代码锚点。

ROADMAP 中的简短矩阵保留为 **索引**；细节以本文档为准。
