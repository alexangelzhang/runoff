# Pipeline Hooks Design — 串联已有模块到主链路

Date: 2026-04-03
Status: Implemented — see `docs/architecture/pipeline-hooks-runtime.md` (durable log + `addEventListener`)

## 背景

experiment-log、experiment-judge、event-log、CostTracker（per-step）、pattern-cache 五个模块已实现但未接入主链路。本设计把它们通过一个 PipelineHooks 中间层串联到 pipeline 执行路径，形成闭环：

```
pattern-cache 注入 context → pipeline 执行 → step cost 记录 → trace 打标 →
experiment-log 记录 → judge 自动对比 → pattern-cache 学习成功模式
```

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 接入方式 | PipelineHooks 中间层 | run-pipeline.ts 只加 ~10 行，符合 CLAUDE.md 50 行约束 |
| 实验声明 | 全量自动记录 | 零配置，每次 pipeline 自动进入实验体系 |
| experimentId | promptHash（复用 pattern-cache 的 hashPrompt） | 同 prompt 多次执行自动归为同一实验 |
| variant | configHash（复用 calculateConfigHash） | 换 provider/参数自动成为不同 variant |
| judge baseline | 同 experimentId 下最早的 approved entry | 全自动，无需人工指定 |
| pattern 使用 | context 注入（拼入 context 参数） | 不污染用户原始 prompt |

## 验证标准

1. **零配置即生效** — 五个模块全部自动工作，无新配置项
2. **向后兼容** — 所有现有测试零改动通过
3. **性能无感** — 全部是同步/微秒级操作（内存查找、文件追加、纯计算），不阻塞 LLM 调用

## 数据流

```
Pipeline 启动
  │
  ├─ onPipelineStart(prompt, config)
  │    ├─ PatternCache.matchPatterns(prompt) → 注入 context
  │    ├─ EventEmitter.pipelineStarted()
  │    └─ 生成 experimentId (promptHash) + variant (configHash)
  │
  ├─ [DAG Loop: 每个 step 执行完]
  │    └─ onStepComplete(stepTrace, costInfo)
  │         ├─ estimateCost() → 写入 stepTrace.cost
  │         └─ EventEmitter.stepFinished()
  │
  └─ onPipelineEnd(trace)
       ├─ trace.experiment = { experimentId, variant }
       ├─ ExperimentLog.appendEntry(entryFromTrace(trace))
       ├─ ExperimentJudge: 查找同 promptHash 的 baseline → judgeExperiment()
       │    └─ 结果写回 experiment entry 的 verdict 字段
       ├─ PatternCache.storeFromTrace(trace)  (仅 approved)
       └─ EventEmitter.pipelineFinished()
```

## 接口设计

### pipeline-hooks.ts

```typescript
// src/pipeline-hooks.ts

interface PipelineStartContext {
  prompt: string;
  config: PipelineConfig;
  traceId: string;
  sessionId: string;
}

interface StepCompleteContext {
  stepTrace: StepTrace;
  stepName: string;
  provider: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

interface PipelineEndContext {
  trace: PipelineTrace;
  costTracker: CostTracker;
}

interface PipelineStartResult {
  /** 从 pattern-cache 匹配到的历史模式，拼入 prompt context */
  patternContext: string;
}

class PipelineHooks {
  private patternCache: PatternCache;
  private eventEmitter: OrchestrationEventEmitter | null;
  private experimentId: string;
  private variant: string;

  constructor(config: PipelineConfig);
  onPipelineStart(ctx: PipelineStartContext): PipelineStartResult;
  onStepComplete(ctx: StepCompleteContext): void;
  onPipelineEnd(ctx: PipelineEndContext): void;
}
```

### StepTrace 扩展

```typescript
// src/trace.ts — StepTrace 新增可选字段
cost?: {
  inputCost: number;
  outputCost: number;
  cachedDiscount: number;
  totalCost: number;
};
```

## 各模块接入逻辑

### pattern-cache（启动注入 + 结束学习）

```typescript
// onPipelineStart — 使用模块级单例避免每次 pipeline 重复加载 memory 目录
let _memory: PersistentAgentMemory | null = null;
function getSharedMemory(): PersistentAgentMemory {
  if (!_memory) _memory = new PersistentAgentMemory();
  return _memory;
}

const patternCache = new PatternCache(getSharedMemory(), { project: "default" });
const patterns = patternCache.matchPatterns(prompt, 3);
const patternContext = patternCache.formatAsContext(patterns);

// onPipelineEnd (仅 approved)
if (trace.finalStatus === "approved") {
  patternCache.storeFromTrace(trace);
}
```

### experiment-log + experiment-judge（全量记录 + 自动对比）

```typescript
// onPipelineEnd

// 1. 打标
trace.experiment = { experimentId, variant, tags: [] };

// 2. 记录
const entry = entryFromTrace(trace);
if (entry) {
  // 3. 找 baseline 并 judge
  const history = queryExperiments({ experimentId });
  const baselineEntry = history.find(e => e.status === "approved");
  if (baselineEntry && trace.finalStatus === "approved") {
    // 按 traceId 直接定位文件（复用 updateTrace 的文件名匹配模式，避免全量扫描）
    const baselineTrace = loadTraceById(baselineEntry.traceId);
    if (baselineTrace) {
      const judgeResult = judgeExperiment(baselineTrace, trace);
      entry.verdict = judgeResult.verdict;
      entry.description = judgeResult.reasons.join("; ");
    }
  }
  appendExperimentEntry(entry);
}
```

### CostTracker per-step cost

```typescript
// onStepComplete
const cost = estimateCost(ctx.model, ctx.usage);
ctx.stepTrace.cost = {
  inputCost: cost.inputCost,
  outputCost: cost.outputCost,
  cachedDiscount: cost.cachedDiscount,
  totalCost: cost.totalCost,
};
```

### event-log

```typescript
// constructor
const eventLog = new InMemoryEventLog();
const emitter = new OrchestrationEventEmitter(eventLog, traceId);

// onPipelineStart
emitter.stepStarted(agentId("pipeline"), traceId);

// onStepComplete
emitter.stepFinished(agentId("pipeline"), ctx.stepName, !ctx.stepTrace.error, ctx.stepTrace.durationMs);

// onPipelineEnd
emitter.agentDisposed(agentId("pipeline"));
```

event-log 当前是 InMemoryEventLog，进程退出即丢。接入价值：
1. 外部 listener 可通过 `emitter.addListener()` 实时消费
2. 后续切 durable adapter 时主链路零改动

## run-pipeline.ts 改动

```typescript
// 位置 1: runPipeline() 开头，costTracker 之后
const hooks = new PipelineHooks(runtimeConfig);
const { patternContext } = hooks.onPipelineStart({ prompt, config: runtimeConfig, traceId, sessionId });
const effectiveContext = patternContext
  ? (context ? `${context}\n\n${patternContext}` : patternContext)
  : context;

// 位置 2: pipeline-runner.ts step 执行完后（costTracker.addCall 附近）
hooks.onStepComplete({ stepTrace: trace, stepName, provider, model, usage });

// 位置 3: recordTrace() 之后
hooks.onPipelineEnd({ trace: finalTrace, costTracker });
```

## 改动清单

| 文件 | 改动类型 | 改动量 |
|------|----------|--------|
| `src/pipeline-hooks.ts` | 新建 | ~120 行 |
| `src/tools/run-pipeline.ts` | 修改 | +10 行 |
| `src/orchestration/pipeline-runner.ts` | 修改 | +3 行 |
| `src/trace.ts` | 修改 | +15 行（StepTrace 加 cost 字段 + 提取 `loadTraceById` 函数） |
| `tests/unit/pipeline-hooks.test.ts` | 新建 | ~100 行 |

总新增约 230 行，run-pipeline.ts 只加 10 行。

## 测试策略

`tests/unit/pipeline-hooks.test.ts` 覆盖：

1. **onPipelineStart — pattern 注入**：mock PersistentAgentMemory，预存 pattern，验证 matchPatterns 返回正确 context
2. **onStepComplete — cost 写入**：验证 stepTrace.cost 字段被正确填充
3. **onPipelineEnd — experiment 全链路**：
   - 第一次执行：无 baseline，entry 无 verdict
   - 第二次执行（同 prompt）：自动找到 baseline，judge 返回 keep/discard/regression
4. **onPipelineEnd — pattern 学习**：approved trace 存入 pattern-cache，failed trace 不存
5. **onPipelineEnd — event-log**：验证 pipelineStarted/stepFinished/agentDisposed 事件序列
6. **向后兼容**：不调用 hooks 时，pipeline 行为不变（现有测试不改动）
