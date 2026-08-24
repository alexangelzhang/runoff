# Harness Evolution 独立工程拆分计划

> ✅ **已执行**（2026-08）：拆分落地为独立工程 `agent-evolution`，本仓库不再依赖它。以下为原计划，保留作为拆分决策与接口契约的记录。
>
> 状态：计划文档 → 已交付
> 形态决策：**独立新仓库**（非 monorepo）
> 依据分析：`docs/architecture/harness-evolution-analysis.md`、本文件第 2 节的依赖实测

## 1. 目标

把 `src/experimental/harness-evolution/`（13 个文件，约 10.3k 行，33 条测试）拆分为独立 TypeScript 工程，**运行时不依赖 runoff**。runoff 通过一组窄接口（TraceStore / TraceScorer / ProviderExecutor / ContextSource）注入宿主能力；包内置 runoff 语义的默认实现与 JSON 目录 TraceStore，runoff 侧仅保留 adapter。

验收标准：

- 新仓库可 `npm install && npm test` 独立运行，不 import 任何 runoff 模块
- 新仓库自带 MCP server 入口 + CLI，artifact root 默认 `~/.harness-evolution/`
- runoff 侧 `pipeline-cli.ts` 与 `runoff_query_context` 工具经 adapter 继续工作
- 既有 `~/.runoff/harness-evolution/` 审计工件可被新包读取（schema 兼容）
- 33 条现有测试迁移后全绿

## 2. 现状事实（2026-08 实测）

### 2.1 外部依赖收敛为 5 个接口点

逐文件 grep `from "../../"` 的结果：

| 耦合点 | 消费方 | 性质 |
|---|---|---|
| `observability/trace.js`（`loadTraceById`/`queryTraces`/`PipelineTrace`） | registry / candidate / evaluation / quality / run / operating-layer | trace 存储与格式 |
| `orchestration/harness.js`（`evaluatePipelineTrace`/`compareRegression`/`TraceEvalResult`/`RegressionTolerance`） | quality（gate 核心）/ evaluation | **verdict 语义（最强耦合）** |
| `providers/types.js`（`LLMProvider`/`LLMResponse`）+ `core/config.js`（`createProvider`/`loadConfig`） | candidate（proposer，只收实例）/ evolve.ts / evolve-cli.ts（工厂） | provider 执行与工厂 |
| `core/state.js` + `orchestration/context-contract.js` + `orchestration/mfs-context-bridge.js` | 仅 `harness-operating-layer.ts` | runoff 特有 context/MFS 路由 |
| `orchestration/durable-io.js` / `tools/mcp-response.js` / `core/paths.js`（`getHarnessEvolutionDir`/`getTracesDir`） | 全部 | 纯工具，可内联 |

外部 npm 依赖：`@modelcontextprotocol/sdk`、`zod`（独立工程可直接声明）。

### 2.2 runoff 内的消费方（拆分必须处理的全部点位）

| 消费方 | 位置 | 处理方式 |
|---|---|---|
| dev CLI | `scripts/ts/dev/pipeline-cli.ts`（80 处 `harnessEvolve*` 引用） | 改为 import 新包 + 注入 runoff TraceStore/provider 工厂 |
| MCP 工具 `runoff_query_context` | `src/tools/query-context.ts`（`resolve_route` 模式调 `resolveHarnessContextRoute`） | **主产品路径上唯一的消费点**；由 runoff adapter 实现 `ContextSource`（MFS bridge）后继续提供 |
| 路径常量 | `src/core/paths.ts`（`getHarnessEvolutionDir`） | 改指向新包的 root 或作为 adapter 的注入值 |
| 测试 | `tests/unit/harness-evolution.test.ts`（迁走）、`tests/unit/pipeline-cli.test.ts`、`tests/unit/mfs-context-bridge.test.ts`（留在 runoff，适配 adapter） | 按 3.5 节处理 |
| 文档 | `AGENTS.md`、`README.md`、`ROADMAP.md`、`docs/architecture/harness-evolution-analysis.md`、`docs/features/observability.md`、`docs/reference/hermes-ase-comparison.md`、`docs/repo-root.md` | 更新引用与说明 |
| MCP 注册 | `src/index.ts` **未注册** `runoff_harness_evolve`（确认无改动） | 无需处理 |

### 2.3 代码规模

```
10214 total（13 文件）
harness-evolve.ts            1646    harness-candidate.ts         948
harness-evolution-types.ts    886    harness-evolution-run.ts     697
harness-quality.ts            659    harness-artifact-store.ts    654
harness-infra.ts              580    harness-registry.ts          458
harness-acceptance.ts         404    harness-evaluation.ts        394
harness-operating-layer.ts   1112    harness-evolve-cli.ts       1563
harness-evolution.ts          213（facade）
```

## 3. 目标形态：独立新仓库

### 3.1 仓库与包

```
harness-evolution/                  # 新仓库（建议名，见 6 决策点）
├── package.json                    # name: @runoff/harness-evolution, type: module
├── tsconfig.json
├── README.md
├── AGENTS.md                       # 迁移 runoff 硬约束 #9 的行为契约
├── src/
│   ├── index.ts                    # facade（原 harness-evolution.ts）
│   ├── contracts.ts                # 【新增】宿主接口契约（3.2）
│   ├── runtime.ts                  # 【新增】注入式运行时（root 目录、TraceStore、scorer）
│   ├── types.ts                    # 原 harness-evolution-types.ts
│   ├── candidate.ts                # 原 harness-candidate.ts（去 trace 直接依赖）
│   ├── registry.ts                 # 原 harness-registry.ts
│   ├── evaluation.ts               # 原 harness-evaluation.ts
│   ├── quality.ts                  # 原 harness-quality.ts
│   ├── acceptance.ts               # 原 harness-acceptance.ts
│   ├── infra.ts                    # 原 harness-infra.ts
│   ├── run.ts                      # 原 harness-evolution-run.ts
│   ├── operating-layer.ts          # 原 harness-operating-layer.ts（MFS 部分拆出，见 3.4）
│   ├── artifact-store.ts           # 原 harness-artifact-store.ts（root 改为注入）
│   ├── mcp/register.ts             # 原 harness-evolve.ts（去 createProvider）
│   ├── cli.ts                      # 原 harness-evolve-cli.ts
│   ├── util/durable-io.ts          # 内联自 runoff（ensureDir/atomicWriteJson/readJsonFile/appendJsonl/readJsonl/safePathSegment）
│   ├── util/mcp-response.ts        # 内联自 runoff（mcpJson/mcpError/mcpErrorFrom）
│   ├── adapters/
│   │   ├── runoff-semantics.ts     # 【新增】复制 runoff 的 evaluatePipelineTrace/compareRegression/traceScore 语义
│   │   └── json-dir-trace-store.ts # 【新增】默认 TraceStore：<root>/traces/YYYY-MM-DD_id.json
│   └── bin/                        # MCP server + CLI 入口（独立 main）
└── test/
    └── harness-evolution.test.ts   # 33 条测试迁移（RUNOFF_HOME → HARNESS_EVOLUTION_HOME + fake TraceStore）
```

### 3.2 宿主接口契约（拆分核心，先冻结这部分）

```ts
// contracts.ts —— 独立包与宿主之间的全部耦合
export interface TraceRecord {
  id: string;
  timestamp: string;
  finalStatus: string;
  prompt?: string;
  promptLength?: number;
  steps: Array<{
    name?: string;
    provider?: string;
    durationMs?: number;
    round?: number;
    verdict?: string;
    error?: string;
    filesModified?: string[];
    [key: string]: unknown;
  }>;
  totalRounds?: number;
  totalDurationMs?: number;
  totalUsage?: { promptTokens?: number; completionTokens?: number };
  costSummary?: {
    totalCostUSD?: number;
    totalTokens?: number;
    breakdown?: Array<{ step?: string; provider?: string; model?: string; tokens?: number; costUSD?: number }>;
  };
  raw?: unknown; // 宿主原始对象，透传给 adapter，包本体不解释
}

export interface TraceStore {
  load(traceId: string): TraceRecord | null;
  query(query: { since?: string }): TraceRecord[];
}

export interface RegressionTolerance {
  durationRatio?: number;
  roundRatio?: number;
}

export interface TraceScorer {
  /** 单 trace 打分（0..1），用于 selection delta 与 benefit 测量 */
  score(trace: TraceRecord | null): number;
  /** 回归判定：candidate 相对 baseline 是否可接受 */
  compareRegression(
    actual: TraceRecord,
    baseline: TraceRecord,
    tolerance?: RegressionTolerance,
  ): { pass: boolean; message?: string };
  /** improvement 判定：返回非空 reason 表示 improvement */
  improvementReason(actual: TraceRecord, baseline: TraceRecord): string | undefined;
}

export interface AgentResult {
  summary?: string;
  changes?: string;
  filesModified: string[];
  diffStat?: string;
  failed?: boolean;
  error?: string;
  model?: string;
}

export interface ProviderExecutor {
  readonly name: string;
  execute(req: {
    prompt: string;
    workDir: string;
    stepName?: string;
    round?: number;
  }): Promise<AgentResult>;
}

/** 可选：operating-layer 的 context 路由。runoff 用 MFS bridge 实现 */
export interface ContextSource {
  readonly kind: string;
  query(ref: string, opts?: Record<string, unknown>): Promise<{ excerpts: string[]; available: boolean }>;
}

export interface HarnessRuntime {
  rootDir: string;        // artifact root（原 ~/.runoff/harness-evolution/ 的注入化）
  traces: TraceStore;
  scorer: TraceScorer;
  providers?: { create(name: string, config?: unknown): ProviderExecutor }; // 可选：MCP/CLI 入口用
  contextSource?: ContextSource; // 可选：仅 context_route_resolve 需要
}

export function setRuntime(rt: HarnessRuntime): void;
export function getRuntime(): HarnessRuntime; // 默认：json-dir TraceStore + runoff-semantics + root=HARNESS_EVOLUTION_HOME ?? ~/.harness-evolution
```

**归属原则**：

- `TraceRecord` 是**最小结构化视图**，`raw` 保留宿主完整对象；包内逻辑只读结构化字段。
- verdict 语义（`score`/`compareRegression`/`improvementReason`）**注入优先**：runoff 侧持续演化语义时只改 adapter，不动包本体；包内置 `runoff-semantics.ts` 作为断链后的独立默认。
- `HARNESS_EVOLUTION_SCHEMA` 字符串值 `"runoff-harness-evolution-v1"` **保持不变**，保证既有 `~/.runoff/harness-evolution/` 工件可读。

### 3.3 关键函数改造映射（依赖倒置清单）

| 现状 | 改造后 |
|---|---|
| `loadTraceById(id)` | `getRuntime().traces.load(id)` |
| `queryTraces({since})` | `getRuntime().traces.query({since})` |
| `locateTraceFile(id)`（registry.ts） | `adapters/json-dir-trace-store.ts` 内实现，包内只消费 `TraceStore` |
| `traceScore()`（evaluation.ts） | `getRuntime().scorer.score()` |
| `compareRegression()` / `evaluatePipelineTrace()`（quality.ts） | `getRuntime().scorer.compareRegression()`；`evaluatePipelineTrace` 在 scorer 内部，包内不再直接调 |
| `improvementReason()`（quality.ts 私有） | 并入 `TraceScorer`，quality.ts 只调接口 |
| `createProvider()` / `loadConfig()`（evolve.ts / cli.ts） | `getRuntime().providers?.create()`；无 provider 工厂时 `propose/run` 要求调用方直接传 `ProviderExecutor` 实例（域核心本就如此） |
| `mfs-context-bridge` 三兄弟（operating-layer.ts） | `ContextSource` 注入；runoff 的 MFS 实现留在 runoff adapter |

### 3.4 operating-layer 的拆法（唯一需要"切文件"的模块）

`harness-operating-layer.ts`（1112 行）里，rule registry / feedback 编译 / GC / autonomy 决策 / context topology CRUD 是**纯域逻辑**（进包）；`resolveHarnessContextRoute` 及其 MFS 检测、`queryMfsContext`、`readLocalContextExcerpt` 是**runoff 特有**（留 runoff）。

```
包内 operating-layer.ts:
  registerHarnessRule / loadHarnessRule / listHarnessRules
  compileHarnessFeedback / listHarnessFeedback
  runHarnessGcLoop / listHarnessGcReports
  registerHarnessAutonomyPolicy / decideHarnessAutonomy / listHarness*
  createHarnessContextTopology / load/list / route registry（纯注册表）
  resolveHarnessContextRoute(ctx, route, contextSource)  ← 依赖 ContextSource，不 import MFS

runoff 侧 src/tools/query-context.ts:
  构造 ContextSource（mfs-context-bridge 实现），调包内 resolveHarnessContextRoute
```

### 3.5 测试迁移

| 测试 | 去向 |
|---|---|
| `tests/unit/harness-evolution.test.ts`（33 条） | 迁入新仓库 `test/`。改造点：`RUNOFF_HOME` → `HARNESS_EVOLUTION_HOME`；`recordTrace`（runoff 写盘函数）→ 新仓库 fake `TraceStore`（内存 Map + 可注入）；`ProposalProvider`/`IterativeProvider` mock 原样迁 |
| `tests/unit/pipeline-cli.test.ts` | 留 runoff，改断言 import 源为包 + adapter |
| `tests/unit/mfs-context-bridge.test.ts` | 留 runoff（它测的是 runoff 的 MFS bridge，不随包走） |

## 4. 分阶段迁移步骤

### Phase A — 新仓库搭建（1-2 天）

1. `git init harness-evolution`，脚手架（package.json / tsconfig / vitest 或 node:test + tsx，沿用现测试风格）
2. 复制 13 文件到新布局，`util/` 内联 durable-io / mcp-response（保留原文件头注释注明来源与 license）
3. `runtime.ts`：`setRuntime/getRuntime`，默认 root `HARNESS_EVOLUTION_HOME ?? ~/.harness-evolution`
4. 迁移 33 条测试：fake TraceStore 替代 `recordTrace`，断言不变
5. Gate A：新仓库 `npm test` 33 绿 + `tsc --noEmit` 干净

### Phase B — 依赖倒置（2-3 天，核心）

1. 按 3.3 映射表逐文件替换直接依赖为 `getRuntime()` 调用
2. `adapters/runoff-semantics.ts`：从 runoff `orchestration/harness.ts` 复制 `evaluatePipelineTrace`/`compareRegression` 语义 + `traceScore` 的 0/1/0.35/0.2 规则（保留注释说明"与 runoff v3.0 语义对齐，之后由 runoff adapter 覆盖"）
3. operating-layer 按 3.4 切分
4. 包内 `mcp/register.ts` 去掉 `createProvider` 依赖
5. Gate B：新仓库独立测试全绿；`grep -rn "runoff"` 只剩文档/注释

### Phase C — runoff 侧 adapter（1 天）

1. 新增 `src/experimental/harness-evolution-adapter/`（runoff 内，2 个小文件）：
   - `trace-store.ts`：包装 `loadTraceById`/`queryTraces` → `TraceRecord`（`raw` 指向原 `PipelineTrace`）
   - `context-source.ts`：包装 `mfs-context-bridge`
   - `runtime.ts`：`setRuntime({ rootDir: getHarnessEvolutionDir(), traces, scorer: runoffSemantics, providers: { create: createProvider }, contextSource })`
2. `package.json` 增加依赖 `@runoff/harness-evolution`（或 git URL，见 6）
3. `scripts/ts/dev/pipeline-cli.ts`：import 改为包；启动时调 adapter `setRuntime`
4. `src/tools/query-context.ts`：`resolve_route` 改走 adapter（MFS 逻辑留在 runoff）
5. Gate C：`npm run ci:gates` + 相关单测全绿

### Phase D — 断链与文档（1 天）

1. 删除 `src/experimental/harness-evolution/`（保留 git 历史），`src/core/paths.ts` 的 `getHarnessEvolutionDir` 改为 adapter 内部常量
2. 文档更新：`AGENTS.md`（硬约束 #9 改指新仓库契约）、`README.md`、`ROADMAP.md`、`docs/architecture/harness-evolution-analysis.md` 加"已拆分"标注与链接
3. 数据连续性：文档写明 `HARNESS_EVOLUTION_HOME=~/.runoff/harness-evolution` 即可读旧工件
4. Gate D：runoff 全量 `npm test` 绿（harness-evolution 测试已迁出，总数减少 33 条属预期）

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| verdict 语义 drift（`orchestration/harness.ts` 之后演化，包内默认跟不上） | 契约归属明确：**语义以注入为准**，`runoff-semantics.ts` 只是包内默认；runoff adapter 永远传自己的当前实现 |
| 测试断链期（Phase B 中途包测试跑不了） | 每步先建接口再替换实现，保持每文件小步可编译；Phase A 完成前不删 runoff 原件 |
| `resolve_route` 主路径回归 | `tests/unit/mfs-context-bridge.test.ts` + `pipeline-cli.test.ts` 是 Phase C 的 gate，未绿不删旧目录 |
| 旧工件兼容 | schema 字符串不变；trace 读取经 adapter 的 `raw` 透传，包只读结构化视图 |
| 独立仓库失去与 runoff 的原子性演进（改接口要发版） | 接口冻结在 `contracts.ts`；扩展用可选字段；包版本 `^1.x` 语义化 |

回滚：任何 Phase 完成前，旧目录未删即可整体回退；Phase D 的删除是唯一不可逆点（可用 git revert）。

## 6. 待决策点（阻塞执行前确认）

1. **仓库/包名**：建议仓库 `harness-evolution`，包名 `@runoff/harness-evolution`；若不想带 org 前缀，用 `harness-evolution`（npm 上需查重）
2. **runoff 依赖方式**：`npm` 发布 vs git URL（`github:user/harness-evolution#v1.0.0`）vs 本地 `file:`——内部迭代期建议 git URL
3. **测试框架**：沿用 `node:test` + `tsx`（与 runoff 一致）还是切 `vitest`——建议沿用，降低迁移噪声
4. **`runoff_harness_evolve` MCP 工具**：新包自带独立 MCP server；runoff 主 server 是否保留该工具的转发注册（现状：未注册，默认不保留）

## 7. 工作量估算

| 阶段 | 内容 | 估时 |
|---|---|---|
| A | 建仓、搬代码、测试迁移 | 1-2 天 |
| B | 依赖倒置、runoff-semantics、operating-layer 切分 | 2-3 天 |
| C | runoff adapter、pipeline-cli、query-context | 1 天 |
| D | 断链、文档、数据连续性说明 | 1 天 |
| 合计 | | **5-7 个工作日** |
