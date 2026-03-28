# LLM Pipeline 升级迭代计划

## 当前状态 (v3.0)

已完成的 5 个 Phase：
1. `llm_run_pipeline` tool + retry 循环
2. N 步有序执行（order 字段）
3. Race 并行模式
4. 智能路由（estimateComplexity）
5. 响应缓存（TTL+LRU）

---

## 与 devin_mini 项目对比

### 定位差异

| | llm-pipeline | devin_mini |
|---|---|---|
| 形态 | Claude Code MCP 插件 | 独立 CLI agent |
| 运行方式 | 被 Claude Code 调用 | 自己跑 agent loop |
| 模型接入 | CLI 进程 + OpenAI API | OpenRouter 统一 API |
| 核心能力 | 多 LLM 任务分发与编排 | 自主编程（12 工具、沙箱、状态管理） |
| 模型切换 | config 静态 + 智能路由动态 | agent 自主 switch_model（按阶段） |
| 状态管理 | 无状态（每次调用独立） | 完整（checkpoint、压缩、恢复） |
| 缓存 | TTL+LRU 响应缓存 | TTL+LRU 响应缓存 |
| 成本追踪 | 无 | 有（token 计数 + 费用估算） |
| 安全 | 无 | 沙箱 + 命令白名单 + 路径校验 |

### 互补关系

**devin_mini 有而 llm-pipeline 缺的：**
- 完整的 agent loop（observe → think → act）
- 状态持久化 + checkpoint 恢复
- 成本追踪（token 计数 + 费用估算）
- 沙箱安全机制
- 上下文压缩（80K token 预算自动截断）
- 12 个内置工具（read/write/edit/search/git/test/memory 等）

**llm-pipeline 有而 devin_mini 缺的：**
- MCP 集成（Claude Code 原生调用）
- 异步 watcher 架构（文件队列 + 多终端可视化）
- 复杂度感知的 reasoning effort 调节
- Skill 编排层（SKILL.md 定义工作流）
- Race 并行模式
- 多步 retry 循环

---

## 整合架构

### 目标架构图

```
┌──────────────────────────────────────────────────────────────┐
│  Claude Code (主编排器)                                       │
│  ↓ MCP                                                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  llm-pipeline MCP Server (v4.0)                        │  │
│  │                                                        │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │              Smart Router                        │  │  │
│  │  │  prompt → estimateComplexity → select provider   │  │  │
│  │  └──────────┬──────────┬──────────┬─────────────────┘  │  │
│  │             │          │          │                     │  │
│  │  ┌──────────▼──┐ ┌────▼─────┐ ┌──▼───────────────┐   │  │
│  │  │ 简单任务     │ │ 中等任务  │ │ 复杂任务          │   │  │
│  │  │ Gemini CLI  │ │ Codex    │ │ devin-mini agent  │   │  │
│  │  │ (fast/cheap)│ │ GPT API  │ │ (autonomous loop) │   │  │
│  │  └─────────────┘ └──────────┘ └───────────────────┘   │  │
│  │             │          │          │                     │  │
│  │  ┌──────────▼──────────▼──────────▼─────────────────┐  │  │
│  │  │           Shared Infrastructure                  │  │  │
│  │  │  ┌─────────┐ ┌─────────┐ ┌───────┐ ┌─────────┐  │  │  │
│  │  │  │  Cache   │ │ Tracker │ │ State │ │ Sandbox │  │  │  │
│  │  │  │ TTL+LRU │ │ Token+$ │ │ Ckpt  │ │ Security│  │  │  │
│  │  │  └─────────┘ └─────────┘ └───────┘ └─────────┘  │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

Watcher 进程（Ghostty / tmux split panes）:
┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐
│ Pane 1       │ │ Pane 2       │ │ Pane 3               │
│ Claude Code  │ │ codex watcher│ │ gemini watcher       │
│ (主会话)     │ │ (异步执行)   │ │ (异步执行)           │
└──────────────┘ └──────────────┘ └──────────────────────┘
```

### 数据流

```
用户请求
  ↓
Claude Code (需求分析, builtin step)
  ↓
llm_run_pipeline(prompt, mode)
  ↓
┌─ pipeline 模式 ──────────────────────────────────────┐
│  Router 评估复杂度                                    │
│    ↓                                                  │
│  Step 1: generate                                     │
│    → 检查 cache → 命中则跳过                          │
│    → 未命中 → Router 选 provider → 执行 → 写入 cache  │
│    ↓                                                  │
│  Step 2: review                                       │
│    → provider 审查代码                                │
│    → APPROVED → 返回结果                              │
│    → NEEDS_REVISION → 带 feedback 重新 generate       │
│    → 最多 maxRounds 轮                                │
└───────────────────────────────────────────────────────┘

┌─ race 模式 ──────────────────────────────────────────┐
│  同时启动 N 个 provider (codex + gemini + ...)        │
│    ↓ Promise.allSettled                               │
│  收集所有结果                                         │
│    ↓                                                  │
│  Claude (judge) 选择最优结果                          │
└───────────────────────────────────────────────────────┘
```

---

## 分阶段整合路线

### Phase 6: devin-mini 作为 provider 接入

**优先级：高 | 改动量：中**

在 llm-pipeline 中新增 `agent` 类型 provider，调用 devin-mini CLI 处理复杂任务。

config 示例：
```json
{
  "providers": {
    "devin-mini": {
      "type": "cli",
      "command": "devin-mini",
      "args": [],
      "description": "Autonomous agent for complex multi-step tasks"
    }
  },
  "routing": [
    { "complexity": "low", "provider": "gemini" },
    { "complexity": "medium", "provider": "codex" },
    { "complexity": "high", "provider": "devin-mini" }
  ]
}
```

关键点：
- devin-mini 已经是 CLI 工具（`devin-mini "task"`），CLIProvider 可直接调用
- 需要处理 devin-mini 的长时间执行（timeout 调大到 10 分钟）
- devin-mini 输出包含完整执行过程，需要提取最终代码

### Phase 7: 成本追踪

**优先级：高（企业必须） | 改动量：小**

从 devin_mini 的 `tracker.py` 移植 token 计数 + 费用估算逻辑到 TypeScript。

新增 `src/tracker.ts`：
```typescript
interface CallRecord {
  step: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCost: number;
  durationMs: number;
}
```

在 `llm_run_pipeline` 返回值中加入：
```json
{
  "cost": {
    "totalTokens": 45678,
    "estimatedUSD": 0.12,
    "breakdown": [
      { "step": "generate", "provider": "codex", "tokens": 30000, "cost": 0.08 },
      { "step": "review", "provider": "gemini", "tokens": 15678, "cost": 0.04 }
    ]
  }
}
```

### Phase 8: Pipeline 执行状态持久化

**优先级：中 | 改动量：中**

借鉴 devin_mini 的 `state.py` 的 save/load 模式。

- 每次 pipeline 执行生成唯一 session ID
- 每步完成后写 checkpoint 到 `~/.llm-pipeline/sessions/{id}.json`
- 支持从 checkpoint 恢复中断的 pipeline
- 新增 `llm_resume_pipeline` tool

状态结构：
```json
{
  "sessionId": "uuid",
  "prompt": "...",
  "currentStep": "review",
  "round": 1,
  "completedSteps": { "generate": { "code": "...", "provider": "codex" } },
  "startedAt": "ISO",
  "lastCheckpoint": "ISO"
}
```

### Phase 9: 上下文压缩

**优先级：中 | 改动量：小**

devin_mini 的压缩策略：当消息超过 80K token 预算时，截断旧的工具输出。

对 llm-pipeline 的适用场景：
- Race 模式返回多个 provider 结果时，总量可能很大
- Pipeline 多轮 retry 时，历史 feedback 累积
- 在 `llm_run_pipeline` 内部，对传给下一步的 context 做压缩

### Phase 10: 安全层

**优先级：中（企业部署前必须） | 改动量：中**

借鉴 devin_mini 的沙箱机制：
- Provider 返回的代码在执行前做安全扫描
- 命令白名单（防止 provider 返回危险命令）
- 路径校验（防止路径遍历）
- 输出截断（防止大输出撑爆 context）

---

## 企业落地优先级总览

```
已完成:
  ✅ Phase 1: llm_run_pipeline + retry
  ✅ Phase 2: N 步有序执行
  ✅ Phase 3: Race 并行模式
  ✅ Phase 4: 智能路由
  ✅ Phase 5: 响应缓存

下一步:
  Phase 6:  devin-mini 作为 provider     ← 能力升级
  Phase 7:  成本追踪                     ← 企业必须
  Phase 8:  状态持久化 + 断点恢复        ← 可靠性
  Phase 9:  上下文压缩                   ← 长任务稳定性
  Phase 10: 安全层                       ← 企业部署前必须
```

---

## 技术债务与注意事项

1. **watcher.sh 的文件轮询机制** — 当前用 100ms 间隔轮询文件系统，企业场景下考虑换成 inotify/fsevents 或 Unix socket
2. **单 provider 串行** — 当前每个 provider 只有一个 task 文件槽位，并发调用同一 provider 会冲突，需要改为 `{provider}.{taskId}.task.json`
3. **config 热加载** — 当前 config 在启动时加载一次，企业场景需要支持不重启更新配置
4. **日志与审计** — 企业使用需要结构化日志，记录每次调用的 provider、耗时、token、结果摘要
5. **OpenRouter 统一接入** — devin_mini 通过 OpenRouter 统一接入所有模型，llm-pipeline 可以考虑加一个 `openrouter` provider type，简化多模型管理
