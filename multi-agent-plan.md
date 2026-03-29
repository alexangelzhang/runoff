# Multi-Agent Orchestration 改造 — 整体规划

## 现状分析

当前架构是一个 DAG-based step pipeline：
- `pipeline.config.json` 定义静态 DAG（步骤 + 依赖 + provider）
- `ExecutionScheduler` 按拓扑序逐 stage 执行，每个 step 绑定一个 LLM provider
- 已有的"多 agent"能力仅限于：Race Mode（同一 step 多 provider 竞速）、Dynamic DAG（step 运行时注入新 step）
- `orchestration/multi-agent-types.ts` 是未接入的脚手架

核心局限：
1. **无 Agent 身份** — step 是匿名的，没有角色、状态、记忆
2. **无 Agent 间通信** — 只有 `globalKnowledge` 单向广播，无定向消息
3. **无动态委派** — orchestrator 不能根据运行时结果决定"谁来做下一步"
4. **无 Handoff 协议** — agent 之间无法交接上下文和控制权
5. **Candidate 是全局单例** — 多 agent 并行修改同一 candidate 会冲突

## 改造目标

从 "step pipeline" 演进为 "multi-agent orchestration"，同时保持向后兼容：

```
现有: Config → DAG → Scheduler → Step(Provider) → Candidate
目标: Config → AgentGraph → Orchestrator → Agent(Role+Provider+State) → SharedContext
```

## 业界对标

### 对标对象

| 框架 | 厂商 | 核心理念 |
|------|------|----------|
| Agents SDK | OpenAI | Agent + Handoff + Guardrails + Tracing |
| Agent SDK | Anthropic | Agent Loop + Tool System + Context Management |
| ADK | Google | Agent 树形层级 + SequentialAgent/ParallelAgent/LoopAgent + A2A 协议 |
| LangGraph | LangChain | 有状态图 (StateGraph) + 节点/边 + 检查点 + Human-in-the-loop |
| CrewAI | 独立 | Role-based Agent + Task + Process (sequential/hierarchical) |
| Agent Framework | Microsoft | Multi-agent + Human Approval Gate + Tool Approval |

### 能力覆盖矩阵

| 维度 | 我们 | 业界最佳实践 | 状态 |
|------|------|-------------|------|
| Agent 抽象 | Wave 7.1 | OpenAI Agent, CrewAI Agent, ADK LlmAgent | 规划中 |
| Agent 通信 | Wave 7.2 | OpenAI Handoff, A2A protocol | 规划中（内部通信） |
| 智能编排 | Wave 7.3 | OpenAI Runner, ADK 根 Agent 委派 | 规划中 |
| 并行冲突解决 | Wave 7.4 | 我们独有（业界多数回避此问题） | 规划中（差异化优势） |
| Config 升级 | Wave 7.5 | CrewAI YAML, ADK Python 声明 | 规划中 |
| Agent Trace | Wave 7.6 | OpenAI Traces Dashboard | 规划中 |
| Guardrails | Wave 7.7 (新) | OpenAI Input/Output Guardrails + Tripwire | **Gap — 高优先级** |
| Human-in-the-Loop | Wave 7.8 (新) | Microsoft Approval Gate, LangGraph interrupt | **Gap — 高优先级** |
| Workflow Agent 原语 | Wave 7.3 补充 | ADK SequentialAgent/ParallelAgent/LoopAgent | **Gap — 中优先级** |
| Durable Control Plane | Wave 7.2/7.6 补强 | LangGraph durable execution, OpenAI Sessions/Tracing | **Gap — 高优先级** |
| Policy / Permissions | Wave 7.7/7.8 补强 | Anthropic permissions, Microsoft tool approval | **Gap — 高优先级** |
| Agent-as-Tool 语义 | Wave 7.3 补充 | OpenAI agent-as-tools + handoff | **Gap — 中优先级** |
| Typed Artifacts / Structured I/O | Wave 7.5/7.9 补充 | A2A artifact, structured outputs | **Gap — 高优先级** |
| Workspace Isolation | Wave 7.4 补充 | worktree/sandbox/lease ownership | **Gap — 高优先级** |
| Replay / Eval | Wave 7.6 补充 | trace replay, regression eval | **Gap — 中优先级** |
| A2A 互操作 | Wave 7.9 (新) | Google A2A 协议 (50+ 合作伙伴) | **Gap — 后期** |
| Agent Memory | Wave 7.10 (新) | 长期记忆 + 向量检索 | **Gap — 后期** |
| DAG 拓扑执行 | ✅ 已有 | LangGraph StateGraph, ADK SequentialAgent | 已覆盖 |
| 并行 stage | ✅ 已有 | ADK ParallelAgent, LangGraph 并行节点 | 已覆盖 |
| Race Mode | ✅ 已有 | 我们独有，业界少见 | 已覆盖（差异化优势） |
| Dynamic DAG | ✅ 已有 | LangGraph conditional edges | 已覆盖 |
| Checkpoint/Resume | ✅ 已有 | LangGraph Checkpointer | 已覆盖 |

### 本轮对标结论（2026-03 更新）

- 当前规划已经从 “runtime core 草案” 提升为 “platform skeleton”，完整度大约可到 **80-85%**。
- 这版最关键的进步是把 `Guardrails`、`Human-in-the-Loop`、`A2A`、`Agent Memory` 纳入了正式规划，方向已经接近 OpenAI / Google / Microsoft / LangGraph 的主流能力图谱。
- 现阶段最大的缺口已不是 “能不能编排多个 agent”，而是 “能不能以 production-grade 方式长期运行”：可恢复、可审计、可审批、可回放、可隔离、可治理。
- 因此，Wave 7 主链需要显式纳入下面这些地基能力，而不是把它们留作实现细节。

### Wave 7 主链必须补齐的地基清单

| 能力 | 为什么必须补 | 建议落点 |
|------|-------------|----------|
| Durable Control Plane | 审批等待、长任务、进程重启、取消恢复都依赖持久化运行态，内存 bus 只够原型 | 7.2 + 7.6 |
| Policy / Permission Engine | Approval 之前必须先有机器可判定的权限策略，否则审批边界会发散 | 7.7 + 7.8 |
| Agent-as-Tool 语义 | manager 保持控制权与 handoff 接管是两种不同编排语义，必须同时支持 | 7.3 |
| Typed Artifacts / Structured I/O | `plan` / `diff` / `review` / `verdict` / `patch` 不能长期靠 `unknown payload` 串联 | 7.5 + 7.9 |
| Workspace Isolation & Ownership | `SharedContext` 只解决逻辑 candidate 冲突，不解决真实文件系统冲突 | 7.4 |
| Replay / Eval Basis | Trace 不仅要看日志，还要支持回放、复盘、故障重演、回归评估 | 7.6 |

## 分阶段实施

### Wave 7.1 — Agent 抽象层（基础设施）

**目标**：引入 Agent 作为一等公民，替代匿名 step

| 改动 | 文件 | 说明 |
|------|------|------|
| 定义 `Agent` 接口 | `src/orchestration/agent.ts` (新) | `AgentId`, `AgentRole`, `AgentConfig`, `AgentInstance`（含 state、memory、provider ref） |
| Agent Registry | `src/orchestration/registry.ts` (新) | 注册/查找/生命周期管理，替代 `getProviderForStep` 的角色 |
| 重构 `multi-agent-types.ts` | `src/orchestration/multi-agent-types.ts` | 整合现有脚手架，删除未用类型，对齐新接口 |
| Agent State | `src/orchestration/agent-state.ts` (新) | 每个 agent 独立的 knowledge、candidate ref、执行历史 |

Agent 接口草案：

```typescript
interface AgentInstance {
  id: AgentId;
  role: AgentRole;
  provider: LLMProvider;
  state: AgentState;          // 独立知识库 + candidate ref
  capabilities: string[];     // "analyze", "refactor", "review", "verify"
  execute(task: AgentTask): Promise<AgentResult>;
}
```

### Wave 7.2 — Agent 间通信 + Durable Control Plane

**目标**：agent 之间可以定向传递消息，并让消息与运行态在暂停、审批、重启后可恢复

| 改动 | 文件 | 说明 |
|------|------|------|
| Message 类型定义 | `src/orchestration/messages.ts` (新) | `AgentMessage { from, to, type, payload, timestamp }` |
| Message Bus 接口 | `src/orchestration/bus.ts` (新) | 定义 send/subscribe/query，开发环境可用内存适配器 |
| Run Store | `src/orchestration/run-store.ts` (新) | 持久化 execution state、approval waits、message cursor、resume token |
| Event Log | `src/orchestration/event-log.ts` (新) | append-only 事件日志，供 replay / audit / recovery |
| 集成到 SchedulerContext | `src/scheduler.ts` | ctx 增加 `messageBus`、`runStore` 引用，agent 执行时可收发消息并保存运行态 |

消息类型：
- `task_delegation` — orchestrator 分配任务
- `result_report` — worker 汇报结果
- `feedback` — reviewer 给 worker 反馈
- `handoff` — agent 间交接控制权
- `knowledge_share` — 定向知识传递

原则：
- Bus 是接口，不是实现；in-memory 仅用于本地开发，生产模式必须切 durable adapter。

### Wave 7.3 — Orchestrator Agent + Workflow Agents（智能调度）

**目标**：将硬编码的 DAG 遍历逻辑提升为可编程的 Orchestrator，并引入 Workflow Agent 原语

| 改动 | 文件 | 说明 |
|------|------|------|
| Orchestrator 接口 | `src/orchestration/orchestrator.ts` (新) | 决策循环：observe → orient → decide → act (OODA) |
| DAG Orchestrator | 同上 | 默认实现，行为等价于当前 `run-pipeline.ts` 的 for 循环，保持向后兼容 |
| LLM Orchestrator | 同上 | 高级实现，用 LLM 做调度决策（"下一步谁来做什么"） |
| Workflow Agents | `src/orchestration/workflow-agents.ts` (新) | 三种确定性编排原语（对标 Google ADK） |
| Agent-as-Tool Adapter | `src/orchestration/agent-tools.ts` (新) | 支持 orchestrator 将 specialist 作为 tool 调用，与 handoff 并存 |
| 重构 `run-pipeline.ts` | `src/tools/run-pipeline.ts` | 将 stage 遍历逻辑委托给 Orchestrator，pipeline 函数变薄 |

Orchestrator 决策接口：

```typescript
interface Orchestrator {
  plan(context: OrchestrationContext): Promise<ExecutionPlan>;
  onStepComplete(result: AgentResult): Promise<NextAction>;
  onStepFailed(error: StepError): Promise<RecoveryAction>;
}

type NextAction =
  | { type: "continue"; nextSteps: string[] }
  | { type: "delegate"; agentId: AgentId; task: AgentTask }
  | { type: "handoff"; from: AgentId; to: AgentId }
  | { type: "retry"; stepName: string; withAgent: AgentId }
  | { type: "done"; status: PipelineStatus };
```

Workflow Agent 原语（对标 Google ADK）：

```typescript
/** 按顺序执行子 agent，前一个的输出作为后一个的输入 */
class SequentialAgent implements AgentInstance { ... }

/** 并行执行子 agent，收集所有结果后合并 */
class ParallelAgent implements AgentInstance { ... }

/** 循环执行子 agent，直到满足终止条件（如 review approved） */
class LoopAgent implements AgentInstance { ... }
```

这三种 Workflow Agent 是无 LLM 开销的纯编排原语，比 DAG 遍历更灵活、可组合。

编排语义要显式区分两类：
- `agent-as-tool`：控制权留在 orchestrator，只把 specialist 当受控能力调用
- `handoff`：控制权真正转交给下一个 agent，后续回合由其主导

### Wave 7.4 — Shared Context & Conflict Resolution

**目标**：多 agent 并行时的 candidate 冲突解决（差异化优势，业界多数回避此问题）

| 改动 | 文件 | 说明 |
|------|------|------|
| SharedContext | `src/orchestration/shared-context.ts` (新) | 替代全局 `candidate` 单例，支持分支/合并语义 |
| Merge Strategy | 同上 | 当多 agent 并行修改时：auto-merge（无冲突）、LLM-merge（有冲突）、pick-winner（race 模式） |
| Workspace Ownership / Lease | `src/workspace/ownership.ts` (新) | 定义 agent 对 worktree/workspace 的独占/共享租约、目录锁、清理与回收 |
| 重构 Candidate | `src/candidate.ts` | Candidate 增加 `branchId`、`parentRef`，支持树状历史 |

`SharedContext` 解决逻辑 candidate 冲突，`Workspace Ownership` 解决真实文件系统冲突；两层缺一不可。

### Wave 7.5 — Config Schema 升级 & 向后兼容

**目标**：`pipeline.config.json` 支持声明 agent 角色和通信拓扑

新 config 格式（向后兼容）：

```jsonc
{
  "providers": { ... },
  // 旧格式仍然工作（自动转换为 agents）
  "pipeline": { "analyze": ["openai-lite"], ... },
  // 新格式：显式声明 agents
  "agents": {
    "planner": { "role": "orchestrator", "provider": "openai-pro", "capabilities": ["plan", "delegate"] },
    "coder": { "role": "worker", "provider": "openai-pro", "capabilities": ["refactor", "implement"] },
    "reviewer": { "role": "reviewer", "provider": "openai-pro", "capabilities": ["review", "verify"] }
  },
  // 新格式：通信拓扑与安全
  "orchestration": {
    "mode": "dag" | "llm-driven" | "workflow",
    "maxHandoffs": 10,
    "conflictResolution": "auto-merge" | "llm-merge" | "pick-winner"
  }
}
```

| 改动 | 文件 | 说明 |
|------|------|------|
| Schema 扩展 | `src/config.ts` | 新增 `agents` 和 `orchestration` 字段，旧 `pipeline` 自动升级 |
| 兼容层 | `src/orchestration/compat.ts` (新) | `pipeline` → `agents` 自动转换逻辑 |
| Typed Artifacts | `src/orchestration/artifacts.ts` (新) | 定义 `PlanArtifact` / `DiffArtifact` / `ReviewArtifact` / `VerdictArtifact` / `PatchArtifact` |
| Validation | `src/config.ts` | 扩展 `validateConfig` 校验 agent 引用完整性 |

内部链路优先传 typed artifact，而非 `unknown payload` 或自由文本。

### Wave 7.6 — Trace / Replay / Eval Baseline

**目标**：trace 不只用于观察，还要支持回放、故障复盘与回归评估

| 改动 | 文件 | 说明 |
|------|------|------|
| Agent Trace | `src/trace.ts` | StepTrace 扩展为 AgentTrace，记录 handoff、message、decision、approval、workspace action |
| Event Stream | `src/orchestration/events.ts` (新) | OrchestrationEvent 发射器，供 trace/logging/UI 消费 |
| Replay Engine | `src/orchestration/replay.ts` (新) | 基于 event log 重放 agent run，支撑 recovery / regression / postmortem |
| Eval Hooks | `src/evals/harness.ts` (新) | 将 trace / artifacts 接入 benchmark case 和回归验证 |

### Wave 7.7 — Guardrails（护栏系统）🆕

**目标**：对标 OpenAI Agents SDK，在 agent 执行前后插入安全校验层

**业界参考**：OpenAI Agents SDK 的 Input/Output Guardrails + Tripwire 机制

| 改动 | 文件 | 说明 |
|------|------|------|
| Guardrail 接口 | `src/orchestration/guardrails.ts` (新) | `InputGuardrail`, `OutputGuardrail`, `GuardrailResult` |
| Tripwire 机制 | 同上 | 护栏触发时立即中断执行（抛 `TripwireError`），而非静默过滤 |
| 内置护栏 | `src/orchestration/builtin-guardrails.ts` (新) | 常用护栏实现 |
| Policy Engine | `src/orchestration/policy.ts` (新) | 按 agent 角色、tool 类型、目录范围、网络访问、预算阈值做 allow/deny/require-approval 决策 |
| 集成到 Agent | `src/orchestration/agent.ts` | AgentInstance 增加 `inputGuardrails` / `outputGuardrails` 字段 |
| Config 支持 | `src/config.ts` | agent 配置中声明护栏规则 |

护栏类型：

```typescript
interface InputGuardrail {
  name: string;
  /** 返回 { tripwire: true } 时中断执行 */
  check(input: AgentTask): Promise<GuardrailResult>;
}

interface OutputGuardrail {
  name: string;
  check(output: AgentResult): Promise<GuardrailResult>;
}

interface GuardrailResult {
  tripwire: boolean;
  reason?: string;
  /** 可选：修正后的内容（soft guardrail 模式） */
  corrected?: unknown;
}
```

内置护栏：
- **PromptInjectionGuardrail** — 检测输入中的 prompt injection 攻击
- **CostLimitGuardrail** — 单步/全局 token 成本上限
- **SensitiveDataGuardrail** — 输出中的 PII/密钥/凭证检测
- **SchemaGuardrail** — 输出格式校验（JSON schema / code syntax）
- **HallucinationGuardrail** — 基于 context 的事实性校验（需 LLM）

注意：Guardrail 不替代 Policy。Guardrail 负责内容/格式/风险检测；Policy 负责能力边界与权限裁决。

### Wave 7.8 — Human-in-the-Loop + Tool Approval 🆕

**目标**：对标 Microsoft Agent Framework 和 LangGraph，在高风险操作前插入人类审批门；前提是 Policy 已先给出 `allow` / `deny` / `require-approval` 判定

**业界参考**：Microsoft Agent Framework Human Approval Gate, LangGraph interrupt_before

| 改动 | 文件 | 说明 |
|------|------|------|
| Approval Gate 接口 | `src/orchestration/approval.ts` (新) | `ApprovalGate`, `ApprovalRequest`, `ApprovalResponse` |
| Tool Approval | 同上 | 每个 tool/provider 可标记 `requiresApproval: true`，并接受 policy 预判 |
| Approval Adapter | 同上 | 可插拔的审批后端（CLI stdin、webhook、MCP callback） |
| 集成到 Orchestrator | `src/orchestration/orchestrator.ts` | 执行前检查是否需要审批，暂停等待 |
| 审计日志 | `src/trace.ts` | 记录每次审批的 request/response/决策者/时间 |

```typescript
interface ApprovalGate {
  /** 判断该操作是否需要人类审批 */
  shouldApprove(action: PendingAction): boolean;
  /** 请求审批，阻塞直到人类响应 */
  requestApproval(request: ApprovalRequest): Promise<ApprovalResponse>;
}

interface ApprovalRequest {
  agentId: AgentId;
  action: string;           // "write_file", "execute_command", "call_api"
  description: string;      // 人类可读的操作描述
  risk: "low" | "medium" | "high";
  context: unknown;         // 操作详情
}

type ApprovalResponse =
  | { decision: "approve" }
  | { decision: "reject"; reason: string }
  | { decision: "modify"; modifications: unknown };
```

风险分级：
- **自动放行**：读文件、搜索、分析（`risk: "low"`）
- **需要审批**：写文件、执行命令、调外部 API（`risk: "high"`）
- **可配置**：用户在 config 中自定义哪些操作需要审批

审批决策链：
1. `Policy Engine` 先判定 `allow` / `deny` / `require-approval`
2. `allow` 直接执行
3. `require-approval` 进入人工审批
4. `deny` 直接拒绝并写审计日志

### Wave 7.9 — A2A 协议适配层（后期）🆕

**目标**：对标 Google A2A 协议，支持与外部 agent 系统互操作

**业界参考**：Google Agent2Agent Protocol (50+ 合作伙伴), 与 MCP 互补

| 改动 | 文件 | 说明 |
|------|------|------|
| A2A Agent Card | `src/orchestration/a2a/agent-card.ts` (新) | 声明本系统 agent 的能力，供外部发现 |
| A2A Task Protocol | `src/orchestration/a2a/task.ts` (新) | 异步任务协商：send/receive/status/cancel |
| A2A Artifact | `src/orchestration/a2a/artifact.ts` (新) | 结果交换格式（代码、diff、报告） |
| A2A Transport | `src/orchestration/a2a/transport.ts` (新) | HTTP/SSE 传输层 |

A2A 与 MCP 的关系：
- **MCP** = agent ↔ tool（我们已有，作为 MCP server）
- **A2A** = agent ↔ agent（跨系统协作）

### Wave 7.10 — Agent Memory（后期）🆕

**目标**：超越 session 级别的 globalKnowledge，引入跨 session 的长期记忆

**业界参考**：LangGraph Memory Store, CrewAI Long-term Memory

| 改动 | 文件 | 说明 |
|------|------|------|
| Memory 接口 | `src/orchestration/memory.ts` (新) | `AgentMemory { store, retrieve, forget }` |
| Trace-based Memory | 同上 | 从历史 trace 中提取成功模式和失败教训 |
| 向量检索（可选） | 同上 | 基于 embedding 的相似经验检索 |

记忆层次：
- **工作记忆** — 当前 session 的 candidate + globalKnowledge（已有）
- **短期记忆** — 最近 N 次 session 的 trace 摘要
- **长期记忆** — 持久化的经验库（成功模式、失败教训、用户偏好）

Memory Governance 要求：
- `scope` — 按 tenant / project / repo / user 隔离
- `retention` — 支持 TTL / archive / compaction
- `security` — 支持 secret redaction / encryption at rest
- `forget policy` — 支持按用户请求删除 / 遗忘

## 依赖关系

```
Phase 5 (Bug fixes) — 先完成 issue5.md / issue6.md 的 P0 项
  │
Wave 7.1  Agent 抽象层
  └── 7.5  Config Schema + Typed Artifacts (稳定内部契约)
       └── 7.2  Message Bus + Durable Control Plane
            ├── 7.7  Guardrails + Policy Engine
            │    └── 7.8  Human-in-the-Loop / Tool Approval
            ├── 7.6  Trace + Replay / Eval Baseline
            ├── 7.4  Shared Context + Workspace Isolation
            │    └── 7.3  Orchestrator + Workflow / Agent-as-Tool
            └── 生产模式必须使用 durable adapter

Wave 7.9  A2A 协议适配层 (后期，依赖 7.1-7.3 稳定)
Wave 7.10 Agent Memory (后期，依赖 7.6 Trace 数据)
```

### 修订版落地顺序（建议）

1. 修 Phase 5 / `issue6.md` 的 P0-P1，先消除合约漂移和生命周期 bug
2. 落 7.1 Agent 抽象，确定实例 / 状态 / 能力边界
3. 落 7.5 最小 config compat + typed artifacts，冻结主链内部契约
4. 落 7.2 durable control plane，使 run / message / approval / resume 可持久化
5. 落 7.7 最小 policy + guardrail skeleton，先把 `allow` / `deny` / `require-approval` 框住
6. 落 7.8 审批链路与 audit log
7. 落 7.6 trace / replay / eval baseline，为回归和故障复盘提供抓手
8. 落 7.4 workspace isolation + conflict resolution
9. 最后再把 7.3 的 LLM-driven orchestrator intelligence 推到主链

## 风险控制

1. **向后兼容**：旧 `pipeline` config 格式始终工作，通过 compat 层自动转换
2. **渐进式**：每个 Wave 独立可交付，7.1 完成后现有功能不受影响
3. **Phase 5 先行**：建议先完成 issue5.md / issue6.md 中的 P0 项（IPC 合约与生命周期修复），避免在有 bug 的基础上搭建新层
4. **Guardrails 前置**：7.7 应尽早实现，生产环境部署的硬性要求
5. **Human-in-the-Loop 渐进**：先支持 CLI stdin 审批，后续扩展 webhook / MCP callback
6. **Policy 前置于 Approval**：先有 machine-enforced `allow` / `deny` / `require-approval`，再谈人工审批，避免所有高风险动作都落到人肉判断
7. **Durable 默认**：凡涉及审批等待、长任务、恢复、取消的链路，生产模式必须走 `RunStore` / `EventLog`；内存实现仅限开发态
8. **Workspace 所有权显式化**：agent 对 worktree / workspace 的占用必须可见、可回收、可审计，避免隐式并发写冲突
9. **Typed Artifact 优先**：核心链路优先传结构化 artifact，不再继续扩散 `unknown` / 自由文本协议

## 工作量估算

| Wave | 新文件 | 改动文件 | 复杂度 | 优先级 |
|------|--------|----------|--------|--------|
| 7.1 Agent 抽象层 | 3 | 1 | 中 | 必须 |
| 7.2 Message Bus + Durable Control Plane | 4 | 1 | 高 | 必须 |
| 7.3 Orchestrator + Workflow / Agent-as-Tool | 3 | 1 | 高 | 必须 |
| 7.4 Shared Context + Workspace Isolation | 2 | 1 | 高 | 必须 |
| 7.5 Config Schema + Typed Artifacts | 2 | 1 | 中 | 必须 |
| 7.6 Trace + Replay / Eval | 3 | 1 | 中 | 必须 |
| 7.7 Guardrails + Policy Engine | 3 | 2 | 中 | 高（生产必需） |
| 7.8 Human-in-the-Loop | 1 | 2 | 中 | 高（生产必需） |
| 7.9 A2A 协议 | 4 | 0 | 中 | 后期 |
| 7.10 Agent Memory | 1 | 1 | 中 | 后期 |

## 参考资料

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
