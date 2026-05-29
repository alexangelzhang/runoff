# llm-pipeline Roadmap

> Last updated: 2026-05-26（Vision 分层说明与代码库同步）

## Vision

从 DAG-based step pipeline 演进为 **production-grade multi-agent orchestration platform**，同时保持向后兼容。

本节区分三件事，避免把「文档目标」当成「已交付终局」：


| 概念                  | 含义                                                      | 状态                                               |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| **North Star**      | 架构演进方向，与 LangGraph / ADK / OpenAI Agents / CrewAI 等同层分解 | 长期对齐，**非唯一全行业终局**                                |
| **Current Runtime** | 今天主路径实际跑的栈                                              | Phase 0–8 已落地，见下表                                |
| **Backlog 桥接**      | 从 Current → North Star 的显式缺口                            | **无开放 Backlog**（B2/B5/B6/B7/B8 已于 2026-05-26 落地） |


### North Star（演进北极星，未全盘实现）

声明式配置编译/加载为可观测的执行图，由 Orchestrator 统一控场，Agent 作为有身份的执行体，共享上下文承载并行合并与跨步知识：

```
Config ──(compile/load)──► AgentGraph
                              │
                              ▼
                        Orchestrator
                              │
                              ▼
              Agent(Role + Provider + State)
                              │
                              ▼
         SharedContext (+ Artifact / Memory / Governance / Trace)
```

**不应写死的「终局」假设：**

- **不会** 用 AgentGraph 一夜替换 `pipeline.config.json`（保持 Config 为声明 SoT，图化是增量，见 B7）。
- **不会** 丢掉 Python worktree / IPC / race 等工程化层（MCP 代码流水线护城河）。
- **不会** 与 Host MCP 或 A2A 合并成单层（协议与编排是正交轴，见 Phase 7.9）。

### Current Runtime（当前最佳主路径，已验证）

今天生产语义上的「最佳合理架构」是 North Star 的 **子集**：Config 仍为声明 SoT，运行时编译 **AgentGraph** 驱波，**AgentStepRunner** → **PipelineStepAgent** → `executePipelineStep` 执行单步（routing / race / prompt）。

```
pipeline.config.json (Config / 声明 SoT)
  → compileAgentGraphFromPipeline (B7)
  → runPipelineExecution → createAndGatePlan
  → AgentRegistry bootstrap
  → runPipelineDAGLoop (agentGraph.waves / executionPlan 驱波)
  → AgentStepRunner → PipelineStepAgent → executePipelineStep (B8)
  → ExecutionGovernance (Policy → Guardrails → Approval)
  → Provider → task_runner.py → workspace_manager.py
  → Checkpoint + Trace + SharedContext (并行 stage 合并)
```

主链代码锚点：`agent-graph.ts` → `pipeline-execution.ts` → `pipeline-runner.ts` → `step-runner.ts` → `step-execution.ts`。

与 North Star 差距：Config 仍为声明 SoT（非图编辑器）；Python IPC / worktree 层保留；多租户联邦目录服务属 Phase 9+。

### 历史对照（便于读旧文档）

```
Legacy（已移除）: Config → DAG → Scheduler → Step(Provider) → Candidate
Current（2026-05）: Config → AgentGraph → Orchestrator → AgentRegistry → AgentStepRunner → PipelineStepAgent → executePipelineStep → Provider
North Star（后续）: 见 [Phase 9+](#phase-9-plus)
```

### 业界同构（层面对齐，非产品克隆）


| 本项目的层         | 常见对标                                                      |
| ------------- | --------------------------------------------------------- |
| Config        | LangGraph 图定义、CrewAI Process、pipeline YAML                |
| AgentGraph    | LangGraph StateGraph、ADK Agent 树（**我们：`agent-graph.ts`**） |
| Orchestrator  | OpenAI Runner、LangGraph invoke、ADK Sequential/Parallel    |
| Agent         | CrewAI Role+Agent、OpenAI Agent+Handoff                    |
| SharedContext | LangGraph shared state；外置记忆另列 Mem0/Zep（Phase 7.10/8.1）    |


差异化不在是否叫 AgentGraph，而在 **git worktree 隔离、provider race、MCP 工具面、治理/观测内建**（见 Industry Benchmarks）。

### Vision → Backlog 映射


| 目标层               | Backlog       | 说明                                                            |
| ----------------- | ------------- | ------------------------------------------------------------- |
| AgentGraph 显式化    | **DONE (B7)** | `compileAgentGraphFromPipeline` + 动态 `appendNodeToAgentGraph` |
| Orchestrator 统一控步 | **DONE (B8)** | `AgentStepRunner` + `PipelineStepAgent` + `step-execution.ts` |
| LLM 规划与 DAG 融合    | **DONE (B6)** | `applyExecutionPlanToAgentGraph` + revision 波次同步              |
| 跨系统 Agent 协作      | **DONE (B5)** | 联邦目录、冲突策略、peer sync                                           |


## Status Legend


| Tag           | Meaning                          |
| ------------- | -------------------------------- |
| `DONE`        | Shipped and verified             |
| `IN PROGRESS` | Active development               |
| `PLANNED`     | Scoped and designed, not started |
| `FUTURE`      | Direction set, details TBD       |


## 完成度总览

**Phase 0–8 勾选交付项均已实现**（`[x]` + Gate 1/2/3 PASSED）。主路径：`runPipelineExecution` → `AgentGraph` → plan gate → `runPipelineDAGLoop` → `AgentStepRunner` → `executePipelineStep`。


| Phase              | 状态     | 验收                           |
| ------------------ | ------ | ---------------------------- |
| 0 Foundation       | `DONE` | Gate 1                       |
| 1 Orchestrator 核心  | `DONE` | 等价性测试 + legacy 已移除           |
| 2 治理               | `DONE` | gate2 G2.4–G2.6              |
| 3 Durable CP       | `DONE` | gate2 G2.1–G2.3              |
| 4 Context/Artifact | `DONE` | gate3 G3.4–G3.5              |
| 5 路由               | `DONE` | 单测 + `step-execution` 接线     |
| 6 E2E              | `DONE` | smoke 脚本 + orchestration-e2e |
| 7 Multi-Agent      | `DONE` | gate3 全项                     |
| 8 对标优化             | `DONE` | phase8 / memory / a2a 测试     |


CI：`npm run ci:gates`（ipc-sync + gate2 + gate3 + 全量单测）。当前约 **580 tests pass**（3 skip）。

---

## Backlog（未完成）

**当前无开放 Backlog 项。** 下列项已于 2026-05-26 落地：


| ID  | 项               | 落地摘要                                                                                      |
| --- | --------------- | ----------------------------------------------------------------------------------------- |
| B2  | PR smoke 门禁     | `.github/workflows/ci-gates.yml` 增加 `smoke` job → `npm run ci:gates:smoke`                |
| B5  | A2A 联邦生产化       | `federation-sync.ts`：冲突策略、`/a2a/federation/directory`、peer sync                           |
| B6  | LLM-driven 深化   | `applyExecutionPlanToAgentGraph`；LLM/revision plan 同步 `agentGraph.waves`                  |
| B7  | AgentGraph      | `agent-graph.ts`                                                                          |
| B8  | Orchestrator 控步 | `step-execution.ts` + `PipelineStepAgent` + `AgentStepRunner`（已移除 `ExecutionScheduler` 类） |


---



## Phase 9+ / 产品 & 技术演进（未排期）

> **说明**：Phase 9+ **不是独立文档**，只是本文件中的一节（约第 132 行）。若链接跳转失败，在 `ROADMAP.md` 内搜索 `phase-9-plus` 或 `Phase 9+`。

ROADMAP **Phase 0–8 与 Backlog 已全部勾选**；下列为文档/代码中提到的 **后续方向**，非承诺交付，需单独立项：


| 主题                    | 说明                                                                           | 参考                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **编排产品化**             | `pipeline-mcp-run.ts` 承载 MCP 会话；`run-pipeline.ts` 仅超时 + 工具注册                 | `src/orchestration/pipeline-mcp-run.ts`                                                                           |
| **Race 冲突策略**         | Provider + 并行 stage：`race-merge.ts`、`stage-merge.ts`                         | `mergeParallelStageBranchesAsync`                                                                                 |
| **A2A 联邦规模化**         | 多节点目录 HA、认证联邦、CRDT/版本向量冲突（B5 为 file + HTTP directory MVP）                    | `federation-sync.ts`、`orchestration.a2a`                                                                          |
| **外置记忆后端**            | Mem0 / Zep 等外置 store 适配（Phase 8.1 为本地 persistent-memory）                     | Phase 8.1、industry-benchmark                                                                                      |
| **可观测深度** `DONE`      | **本地可观测模块**（借鉴思路、不接 SaaS）：[`docs/observability.md`](docs/observability.md) · `llm_query_traces` / `llm_query_experiments` | `src/trace.ts` · `experiment-log.ts` · `observability-dataset.ts`                                                 |
| **外置记忆生产化** `DONE`   | MCP 状态/查询 + M1 热路径 hybrid retrieve + 按 run session 绑定 Zep | [`docs/memory-production.md`](docs/memory-production.md) · `pipeline-memory.ts` · `dream-state.ts` |
| **Dream v1** `DONE` | 三轨离线 worker + `llm_dream_run` + audit/state；vault **解耦** | [`docs/dream.md`](docs/dream.md) · `src/dream/*` |
| **Dreamify** `DONE` | 网格调参 + `best-params.json` + `llm_dreamify_tune` | [`docs/dreamify.md`](docs/dreamify.md) · `src/dreamify/*` |
| **Memory M4** `DONE` | 多策略检索 · 实体双时间戳 · `dream-export.jsonl` · show_config dreamify | `dreamify-multi-retrieve.ts` · `dream-export.ts` |
| **DeerFlow 式规划** `DONE` (MVP) | 窄范围 reflect→re-plan：`review_revision` / `step_failure` 触发，写回 `agentGraph` + `plan_revision` 事件 | [`docs/deerflow-reflect.md`](docs/deerflow-reflect.md) · `reflect-planner.ts` · `reflect.ts` · `LLMOrchestrator.reflectAndReplan` |
| **P0 开源发布包** `DONE` | MIT · 贡献指南 · `npm run demo` · `pipeline:run` · 多 coding-agent 后端文档（**非** Docker/devcontainer） | [`docs/OPEN_SOURCE.md`](docs/OPEN_SOURCE.md) · [`LICENSE`](LICENSE) · [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CHANGELOG.md`](CHANGELOG.md) · [`examples/`](examples/) · [`scripts/pipeline-cli.ts`](scripts/pipeline-cli.ts) |
| **开源差异化文档** `DONE` | Why us + AutoGen/CrewAI/LangGraph/OpenHands 矩阵；coding-agent backends | [`docs/differentiation.md`](docs/differentiation.md) · [`docs/coding-agent-backends.md`](docs/coding-agent-backends.md) · [`docs/industry-benchmark.md`](docs/industry-benchmark.md) |
| **技术债 / issues**      | issue5–8 已全部 `_close`（2026-05-28）                                            | `[issues/OPEN-BACKLOG.md](issues/OPEN-BACKLOG.md)` · `[issues/P0-TRIAGE-2026-05.md](issues/P0-TRIAGE-2026-05.md)` |
| **Pipeline Hooks 深化** | `addEventListener`、durable control plane 文档                                  | `docs/pipeline-hooks-runtime.md`                                                                                  |
| **AgentGraph 工具**     | JSON / Mermaid / HTML（`format` 参数）                                           | `agent-graph-viz.ts`                                                                                              |
| **外置记忆**              | HTTP 适配层（Mem0/Zep 代理）；生产清单见 `memory-production.md`                          | `docs/external-memory.md`                                                                                         |
| **A2A 联邦 HA**         | 目录鉴权、重试、备份                                                                   | `docs/a2a-federation.md`                                                                                          |
| **行业对标维护**            | `npm run check-benchmark-pins`（ci:gates）；季度 `npm run refresh-benchmark-pins` | `docs/benchmark-pins.json`                                                                                        |


---

## Phase 0: Foundation — `DONE`

Gate 1 验收通过（2026-03-29）。地基已固化。

- IPC 合约一致性（TS ↔ Python）
- Workspace 生命周期（create → commit → collect → apply → destroy）
- Lock 语义（exclusive 互斥 + shared 共存 + backoff）
- Race finalize（apply winner → abort losers）
- Config 校验（畸形 config 报错明确）
- ~545 tests passing (3 skip), `tsc --noEmit` clean；`npm run ci:gates`

---

## Phase 1: Orchestrator 成为 runtime 核心 — `DONE`

**目标**：run-pipeline.ts → orchestrator plan gate → AgentRegistry → provider（`pipeline-runner` 仍负责 DAG 步进，见 Backlog B3）。

- 1.1 主链路切换到 Orchestrator（`runPipelineExecution` + plan gate + registry bootstrap） — `pipeline-execution.ts`, `run-pipeline.ts`
- 1.2 AgentRegistry + AgentState 接入执行面（orchestrator 路径 bootstrap registry） — `registry.ts`, `agent.ts`, `agent-state.ts`
- 1.3 等价性 CI 全绿（`tests/pipeline-execution-equivalence.test.ts`）
- 1.4 移除 legacy runner（仅 orchestrator + AgentRegistry 路径） — `pipeline-execution.ts`
- 1.5 Orchestrator 驱波（`executionPlan` + `plan-scheduler.ts`，`onStepComplete`/`onStepFailed`） — Backlog B3

**风险**：切换过程中现有测试必须持续通过。

---

## Phase 2: 治理框架 — `DONE`

**目标**：任何执行边界都可以挂 policy check，返回 ALLOW / BLOCK / REQUIRE_APPROVAL。

- 2.1 通用审批框架接入主链 — `execution-governance.ts`, `policy.ts`, `approval.ts`
- 2.2 内置 guardrails（CostLimit / Loop / Success + PII / Secrets / Injection / Path / Output） — `guardrails.ts`, `guardrail-scan.ts`
- 2.3 config 声明式 governance 规则模板（`runtime.governance.rules` 文档化） — `docs/governance-config.md`, `config.ts` 校验

---

## Phase 3: Durable Control Plane — `DONE`

**目标**：bus events 写入 event-log，run-store 基于 event-log 重建状态，支持 approval wait + resume。

- 3.1 Bus + RunStore + EventLog 持久化（`File`* adapters + `runtime.controlPlane: "file"`） — `durable-*.ts`, `control-plane.ts`
- 3.2 Approval Wait + Resume helpers（`pauseRunForApproval` / `resumeRunAfterApproval`） — `run-control.ts`
- 3.3 主链 policy 触发审批暂停 + MCP `approvalDecision` resume — `execution-governance.ts`, `approval-adapters.ts`

---

## Phase 4: 统一 Context / Artifact / Workspace — `DONE`

**目标**：artifact 作为中间层，shared-context 产出 artifact，workspace 消费 artifact 做物理文件操作。

- 4.1 三层模型打通（`collectRunArtifacts` → `applyWorkspaceFromArtifacts` 主链 finalize） — `artifact-workspace.ts`, `run-pipeline.ts`
- 4.2 Multi-agent 并行协作（branch + merge + 租约） — `shared-context.ts`, `context-integration.ts`, `pipeline-runner.ts`

---

## Phase 5: 路由策略升级 — `DONE`

- 5.1 复杂度评估升级 — `inferTaskType` + `applyTaskTypeBias` + `scoreProviderCandidates`（trace 胜率）
- 5.2 Provider Circuit Breaker — `provider-circuit.ts` + `scheduler` 接线 `isProviderAvailable` / `recordProviderOutcome`
- 5.3 Provider Tier 声明化 — `ProviderConfig.tier` + `getProviderTier` / `findUpgradedProvider` + `validateConfig`
- 5.4 Race Mode 成本控制 — `race-execution.ts` + `orchestration.raceBudgetUSD` / `raceEarlyTermination`
- 5.5 Retry 升级策略精细化 — `retry-strategy.ts` + `pickRetryProvider`（timeout→lite，quality→full）

---

## Phase 6: 端到端验证 — `DONE`

- 6.1 Real Provider Smoke Tests — `tests/real-provider.integration.test.ts` + `scripts/run-real-provider-smoke.ts` + nightly/pre-release workflows + `tests/real-provider-smoke.test.ts`（runner 契约）
- 6.2 Orchestration 集成测试（workflow 路径 + CP crash recovery） — `tests/orchestration-e2e.test.ts`

---

## Phase 7: Multi-Agent Orchestration — `DONE`

从 "step pipeline" 演进为 "multi-agent orchestration"。各 Wave 已交付；高级记忆能力见 Phase 8。

### 7.1 Agent 抽象层

引入 Agent 作为一等公民，替代匿名 step。参考 DeerFlow 角色化分工模式。

- `Agent` 接口（AgentId, AgentRole, AgentConfig, AgentInstance） — `agent.ts`
- Agent Registry（注册/查找/生命周期） — `registry.ts`
- Agent State（独立 knowledge + candidate ref + 执行历史） — `agent-state.ts`

### 7.2 Agent 间通信 + Durable Control Plane

Agent 间定向消息传递，运行态在暂停/审批/重启后可恢复。

- Message 类型（task_delegation, result_report, feedback, handoff, knowledge_share） — `messages.ts`
- Message Bus 接口（send/subscribe/query，in-memory + `FileMessageBus`） — `bus.ts`, `durable-bus.ts`
- Run Store（持久化 execution state, approval waits, resume token） — `run-store.ts`, `durable-run-store.ts`
- Event Log（append-only，供 replay/audit/recovery） — `event-log.ts`, `durable-event-log.ts`

### 7.3 Orchestrator + Workflow Agents

将硬编码 DAG 遍历提升为可编程 Orchestrator。参考 DeerFlow Plan→Execute→Reflect 闭环。

- Orchestrator 接口（plan / onStepComplete / onStepFailed） — `orchestrator.ts`
- DAG Orchestrator（`buildExecutionPlanFromPipeline` + DAG stages） — `orchestrator.ts`
- LLM Orchestrator（policy-driven，`orchestration.mode: llm-driven`） — `LLMOrchestrator` in `orchestrator.ts`
- Workflow Agents 接入主链（`orchestration.mode: workflow` + `ParallelAgent.executeAll`） — `workflow-bridge.ts`, `pipeline-runner.ts`
- Agent-as-Tool Adapter（`buildAgentToolRegistry` + `orchestration.useAgentTools` 主链） — `agent-tools.ts`, `pipeline-execution.ts`

### 7.4 Shared Context & Conflict Resolution

多 agent 并行时的 candidate 冲突解决（差异化优势）。

- SharedContext（并行 stage 分支 + 合并回 `state.candidate`） — `shared-context.ts`, `context-integration.ts`, `pipeline-runner.ts`
- Merge Strategy（`orchestration.conflictResolution` → auto-merge / pick-winner） — `context-integration.ts`
- Workspace Ownership / Lease（并行 stage 用 shared，串行用 exclusive） — `ownership.ts`, `pipeline-runner.ts`

### 7.5 Config Schema 升级

`pipeline.config.json` 支持声明 agent 角色和通信拓扑，旧格式自动转换。

- Schema 扩展（`agents` + `orchestration` 字段） — `config.ts`
- 兼容层（`pipeline` → `agents` 自动转换） — `compat.ts`
- Typed Artifacts 主链（`StepResult.artifacts` + `artifact-bridge.ts`） — `artifacts.ts`, `scheduler.ts`, `pipeline-runner.ts`

### 7.6 Trace / Replay / Eval

Trace 不只用于观察，还要支持回放、故障复盘与回归评估。

- AgentTrace（PipelineTrace 扩展 orchestrationEvents / handoffs / approvals） — `trace.ts`, `replay.ts`
- Replay Engine（EventLog → trace 记录，主链 `enrichTraceWithEventLog`） — `replay.ts`, `run-pipeline.ts`
- Eval Hooks（trace 评分 + 回归对比） — `harness.ts`, `evaluatePipelineTrace`, `compareRegression`

### 7.7 Guardrails + Policy Engine

对标 OpenAI Agents SDK，在 agent 执行前后插入安全校验层。

- Guardrail 接口（Input/Output + Tripwire 中断） — `guardrails.ts`
- 内置护栏（CostLimit, Success, LoopDetection, PII, Secrets, PromptInjection, ForbiddenPath, EmptyOutput, OutputSize, OutputFormat） — `guardrails.ts`, `guardrail-scan.ts`
- Policy Engine 接入主链（allow / deny / require-approval） — `execution-governance.ts`

Guardrail 负责内容/格式/风险检测；Policy 负责能力边界与权限裁决。

### 7.8 Human-in-the-Loop + Tool Approval

对标 Microsoft Agent Framework + DeerFlow Plan 确认暂停。分两阶段：

- Phase A：Plan-level approval（`plan-control.ts`，`awaiting_plan_approval` + MCP resume） — `pipeline-execution.ts`, `run-pipeline.ts`
- Phase B：Action-level approval（policy require-approval + defer 暂停） — `execution-governance.ts`
- Approval Gate 接口（shouldApprove + requestApproval） — `approval.ts`
- Approval Adapter（auto / defer / callback） — `approval-adapters.ts`
- 审计日志（event-log `approval_`* + `PipelineTrace.approvals`） — `approval-audit.ts`, `replay.ts`

### 7.9 A2A 协议适配层 — `DONE`

对标 Google A2A 协议，支持与外部 agent 系统互操作。MCP = agent↔tool，A2A = agent↔agent。

- A2A Agent Card / Task Protocol / Artifact / Transport — `a2a/*.ts`
- Config → AgentCard registry + in-memory transport stub — `a2a/config-bridge.ts`
- HTTP/SSE loopback Transport — `a2a/http-transport.ts`
- HTTP/SSE 鉴权 + 服务发现（`GET /a2a/agents`，Bearer on `/a2a/send`）
- HTTP/SSE mTLS + 外部服务发现 — `tls-config.ts`, `external-registry.ts`, `orchestration.a2a` config
- 联邦 registry 持久化 — `federated-registry-store.ts`（`~/.llm-pipeline/a2a-federation/agents.json`）

### 7.10 Agent Memory — `DONE`

超越 session 级别的 globalKnowledge，引入跨 session 长期记忆（语义检索、实体图、联想注入等见 Phase 8.1）。

- AgentMemory 接口（store / retrieve / forget） — `memory.ts`, `persistent-memory.ts`
- Pattern cache + decay — `pattern-cache.ts`, `memory-decay.ts`
- 记忆压缩/合并 — `memory-merge.ts`
- secret redaction 治理 — `memory-redaction.ts`
- 8.1.1–8.1.7 记忆对标项 — 见 Phase 8.1（均已 `[x]`）

---

## Phase 8: 对标优化 — 记忆 / 成本 / 可观测性 — `DONE`

基于 Mem0、Zep、A-MEM、LangSmith、Arize Phoenix、OpenTelemetry、DeerFlow 对标分析。横切优化，不依赖 Phase 1-7 架构重构。

### 8.1 记忆系统升级（对标 Mem0 / Zep / A-MEM）

- 8.1.1 记忆衰减函数 `decayedRelevance = relevance * exp(-λ * age)` — Zep (P0)
- 8.1.2 记忆压缩/合并（同 category + 相似 content 自动合并） — Mem0 (P0)
- 8.1.3 语义检索（local embedding + cosine；`MemoryQuery.semanticQuery`） — Mem0 (P1)
- 8.1.4 Relevance 反馈回路（`feedbackRelevanceFromTrace` in pipeline-hooks） — Mem0 (P1)
- 8.1.5 Pattern 关联（filesModified 交集 → `relatedPatternIds`） — A-MEM (P2)
- 8.1.6 Trace 实体关系提取（`trace-entities.ts` provider→file→verdict） — Zep (P2)
- 8.1.7 联想式 context 注入（`buildAssociativeContext` + file-linked patterns） — A-MEM (P3)

### 8.2 成本优化

- 8.2.1 CostTracker → CostGovernor（pipeline 级预算上限） (P0)
- 8.2.2 语义缓存（token Jaccard ≥ 0.95 复用结果；`runtime.semanticCache`） (P1)
- 8.2.3 路由打分升级（`scoreProviderCandidates` + trace 胜率） (P1)
- 8.2.4 Provider tier 声明化（`ProviderConfig.tier`） (P1)
- 8.2.5 缓存 L2 持久化（LRU 淘汰写 `~/.llm-pipeline/cache/l2-store.json`，启动预热） (P2)
- 8.2.6 Trace 时序衰减（`traceRecencyWeight` in `aggregateTraceStats`） (P1)

### 8.3 可观测性升级（对标 LangSmith / Arize / OTel / DeerFlow）

- 8.3.1 IPC 加时间戳（分段延迟） — DeerFlow (P0)
- 8.3.2 激活实验链路（trace → experiment-log → judge → pattern-cache） — LangSmith (P0)
- 8.3.3 StepTrace 加 `spanId`（`createStepSpanId`） — OTel (P1)
- 8.3.4 ProviderStat 加 P50/P95/P99 — Arize (P1)
- 8.3.5 StepTrace 加结构化 `errorDetail` — DeerFlow (P1)
- 8.3.6 StepTrace 加 cost 字段 — DeerFlow (P1)
- 8.3.7 JudgeResult 多维评分（`JudgeDimensionScores`） — LangSmith (P2)
- 8.3.8 时间分桶 + 漂移检测（`trace-drift.ts`） — Arize (P2)
- 8.3.9 EventLogEntry 关联 spanId — `event-log-span.ts` (P2)
- 8.3.10 OTel 导出（`TraceExporter` + OTLP/HTTP `OtlpHttpTraceExporter`；`runtime.otelEndpoint` / `OTEL_EXPORTER_OTLP_ENDPOINT`） — OTel (P3)
- 8.3.11 Prompt 版本存储 + 回放（`prompt-version.ts` + `StepTrace.promptVersionId`） — LangSmith (P3)

---

## Dependency Graph

```
Phase 0 (DONE)
  │
  ├─ Phase 1: Orchestrator 核心
  │    └─ Phase 7.1: Agent 抽象
  │         └─ Phase 7.5: Config Schema + Typed Artifacts
  │              └─ Phase 7.2: Message Bus + Durable Control Plane
  │                   ├─ Phase 7.7: Guardrails + Policy
  │                   │    └─ Phase 7.8: Human-in-the-Loop
  │                   ├─ Phase 7.6: Trace + Replay + Eval
  │                   ├─ Phase 7.4: Shared Context + Workspace Isolation
  │                   │    └─ Phase 7.3: Orchestrator + Workflow Agents
  │                   └─ 生产模式必须使用 durable adapter
  │
  ├─ Phase 2: 治理框架（与 Phase 7.7 合并落地）
  ├─ Phase 3: Durable Control Plane（与 Phase 7.2 合并落地）
  ├─ Phase 4: Context/Artifact/Workspace（与 Phase 7.4/7.5 合并落地）
  ├─ Phase 5: 路由升级（Phase 1 稳定后）
  ├─ Phase 6: 端到端验证（每个 Phase 完成后持续跑）
  │
  ├─ Phase 7.9: A2A（依赖 7.1-7.3 稳定）
  ├─ Phase 7.10: Agent Memory（依赖 7.6 Trace 数据）
  │
  └─ Phase 8: 对标优化（横切，不依赖 Phase 1-7，可并行推进）
```

## Recommended Execution Order

**当前优先级**：Backlog 已清空；新需求见 [Phase 9+](#phase-9-plus)。

---

## Quality Gates

### Gate 1 — Foundation — `PASSED` (2026-03-29)


| #    | 检查项            | Pass 标准                             |
| ---- | -------------- | ----------------------------------- |
| G1.1 | `tsc --noEmit` | 零错误                                 |
| G1.2 | `npm test`     | 0 fail, skip ≤ 5                    |
| G1.3 | Workspace 生命周期 | create→destroy 无残留，patch round-trip |
| G1.4 | IPC 合约一致性      | TS manifest = Python dataclass      |
| G1.5 | Lock 语义        | exclusive 互斥 + shared 共存，无死锁        |
| G1.6 | Race finalize  | winner patch 正确，loser workspace 清理  |
| G1.7 | Config 校验      | 畸形 config 报错明确                      |


### Gate 2 — Durable Control Plane — `PASSED` (2026-05-26)

触发条件：Phase 7.2 完成后。验收：`npm run test:gate2`（`tests/gate2-control-plane.e2e.test.ts`）。


| #    | 检查项                   | Pass 标准                            | Status |
| ---- | --------------------- | ---------------------------------- | ------ |
| G2.1 | Run Store 持久化         | kill → restart → resume，state 完整恢复 | passed |
| G2.2 | Event Log append-only | 100+ events 顺序一致，无丢失               | passed |
| G2.3 | Message Bus 可靠投递      | 不丢、不重复、顺序正确                        | passed |
| G2.4 | Approval 暂停/恢复        | 暂停期间不推进，恢复后从断点继续                   | passed |
| G2.5 | Agent 生命周期            | create→execute→handoff→destroy 无泄漏 | passed |
| G2.6 | Config compat         | 旧格式自动升级，行为等价                       | passed |
| G2.7 | Typed Artifacts       | 核心链路零 `unknown payload`            | passed |


阻塞规则：G2.1-G2.3 fail → 阻塞 Phase 7.3。G2.4 fail → 阻塞 Phase 7.8。

### Gate 3 — Orchestrator + SharedContext — `PASSED` (2026-05-26)

触发条件：Phase 7.3 + 7.4 + 7.8 完成后。验收：`npm run test:gate3`（`tests/gate3-orchestrator.e2e.test.ts`）。


| #    | 检查项                 | Pass 标准                                       | Status |
| ---- | ------------------- | --------------------------------------------- | ------ |
| G3.1 | 向后兼容                | 旧 config 端到端输出一致                              | passed |
| G3.2 | DAG Orchestrator    | 相同 config 产生相同执行顺序                            | passed |
| G3.3 | Workflow Agents     | Sequential/Parallel/Loop 各一个 integration test | passed |
| G3.4 | SharedContext 冲突解决  | 2 agent 并行修改 → merge 正确                       | passed |
| G3.5 | Workspace Ownership | 租约互斥，超时可回收                                    | passed |
| G3.6 | Guardrail 拦截        | tripwire 生效，审计日志完整                            | passed |
| G3.7 | Human Approval E2E  | 全链路通畅，审计可追溯                                   | passed |
| G3.8 | Trace 完整性           | 每个 step/handoff/message/approval 均有 trace     | passed |
| G3.9 | 性能基线                | 延迟 overhead ≤ 15%                             | passed |


阻塞规则：G3.1-G3.2 fail → 不得合入 main。G3.6-G3.7 fail → 不得部署生产。

---

## Risk Mitigation

1. **向后兼容**：旧 `pipeline` config 始终工作，compat 层自动转换
2. **渐进式**：每个 Wave 独立可交付
3. **Guardrails 前置**：7.7 尽早实现，生产部署硬性要求
4. **Policy 前置于 Approval**：先有 machine-enforced 策略，再谈人工审批
5. **Durable 默认**：审批/长任务/恢复链路必须走 RunStore/EventLog
6. **Workspace 所有权显式化**：agent 对 worktree 的占用可见、可回收、可审计
7. **Typed Artifact 优先**：核心链路不再扩散 `unknown` / 自由文本

---

## Industry Benchmarks

**完整双层对标（战略概念 + 战术代码路径 @ pinned SHA）：** [docs/industry-benchmark.md](docs/industry-benchmark.md)  
**版本钉扎：** [docs/benchmark-pins.json](docs/benchmark-pins.json) — 刷新：`./scripts/refresh-benchmark-pins.sh`


| 层级  | 文档章节                    | 用途                                          |
| --- | ----------------------- | ------------------------------------------- |
| 战略  | industry-benchmark §1   | Vision 五层映射、能力矩阵、差异化                        |
| 战术  | industry-benchmark §2–3 | 各框架 `blob/{ref}/{path}` 与 llm-pipeline 模块对照 |


### 对标框架（战略索引）


| 框架         | 厂商        | 核心理念                                   | 战术入口（2026-05-26 pin）                        |
| ---------- | --------- | -------------------------------------- | ------------------------------------------- |
| Agents SDK | OpenAI    | Agent + Handoff + Guardrails + Tracing | `src/agents/run.py`                         |
| ADK        | Google    | Agent 树 + Sequential/Parallel + A2A    | `src/google/adk/agents/sequential_agent.py` |
| LangGraph  | LangChain | StateGraph + Checkpointer + HITL       | `libs/langgraph/langgraph/graph/state.py`   |
| CrewAI     | 独立        | Role Agent + Crew + Flow               | `lib/crewai/.../crew_agent_executor.py`     |
| DeerFlow   | 字节跳动      | Plan→Execute→Reflect（LangGraph）        | 见 industry-benchmark §2.6                   |
| Agent SDK  | Anthropic | Host loop + tools                      | 未纳入 E2（Host 侧）                              |


### 能力覆盖矩阵（战略 — 细节见 industry-benchmark §1.2）


| 维度                 | 状态                                       | 业界参考                                 |
| ------------------ | ---------------------------------------- | ------------------------------------ |
| DAG 拓扑执行           | ✅                                        | LangGraph StateGraph, ADK Sequential |
| 并行 stage           | ✅                                        | ADK ParallelAgent                    |
| Race Mode          | ✅ 独有                                     | 业界少见                                 |
| Checkpoint/Resume  | ✅                                        | LangGraph Checkpointer               |
| Guardrails         | ✅ DONE (7.7)                             | OpenAI `guardrail.py`                |
| Human-in-the-Loop  | ✅ DONE (7.8)                             | LangGraph interrupt, MS Approval     |
| A2A                | ✅ / B5 联邦                                | ADK `remote_a2a_agent.py`            |
| AgentGraph 运行时 SoT | ✅ B7 `agent-graph.ts`                    | LangGraph 原生                         |
| Orchestrator 控步入口  | ✅ `step-runner.ts` + `step-execution.ts` | ADK workflow agents                  |


### 对标结论（2026-05）

能力勾选完整度约 **95%+**（战略）。战术对齐度以 [industry-benchmark.md](docs/industry-benchmark.md) 为准。Backlog **B2–B8** 均已落地。

---

## References

- [OpenAI Agents SDK Architecture Patterns 2026](https://apiscout.dev/blog/openai-agents-sdk-architecture-patterns-2026)
- [OpenAI Agents SDK Guardrails](https://openai.github.io/openai-agents-python/guardrails/)
- [OpenAI Agents SDK Multi-Agent Orchestration](https://openai.github.io/openai-agents-python/multi_agent/)
- [Google ADK Multi-Agent Systems](https://google.github.io/adk-docs/agents/multi-agents/)
- [Google A2A Protocol](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [Google ADK Agent Types and Hierarchy](https://deepwiki.com/google/adk-python/3.1-agent-types-and-hierarchy)
- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Microsoft Agent Framework Human Approval](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/multi-agent-workflow-with-human-approval-using-agent-framework/4465927)
- [Human-in-the-Loop Approval Framework Pattern](https://www.agentic-patterns.com/patterns/human-in-loop-approval-framework/)
- [LangGraph vs CrewAI vs OpenAI Agents SDK 2026](https://particula.tech/blog/langgraph-vs-crewai-vs-openai-agents-sdk-2026)
- [AI Agent Framework Comparison 2026](https://shipsquad.ai/blog/ai-agent-framework-comparison-2026)
- [DeerFlow — ByteDance Deep Research Multi-Agent Framework](https://github.com/bytedance/deer-flow)
- [Mem0 — Production-ready Scalable Long-term Memory](https://github.com/mem0ai/mem0)
- [Zep — Temporal Knowledge Graph Memory](https://github.com/getzep/zep)
- [A-MEM — Dynamic Interconnected Knowledge Network](https://arxiv.org/abs/2409.07286)
- [LangSmith — LLM Observability & Evaluation Platform](https://docs.smith.langchain.com/)
- [Arize Phoenix — LLM Observability & Tracing](https://github.com/Arize-AI/phoenix)
- [OpenTelemetry Semantic Conventions for GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/)

