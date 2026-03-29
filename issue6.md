# Phase 6 Review — 地基重浇清单

## P0 — 契约统一 & 主链修复

| # | 问题 | 文件 | 说明 |
|---|------|------|------|
| 6.1 | `config` 契约存在双轨制（tuple DAG DSL 与旧对象 DSL 并存） | `src/config.ts`, `src/tools/show-config.ts`, `tests/config.test.ts` | 配置读取、校验、展示、测试使用的 schema 不一致，导致工具层、测试层和运行层理解的是不同配置模型 |
| 6.2 | Provider factory wiring 错误且被 `any` 掩盖 | `src/config.ts`, `src/providers/openai.ts`, `src/providers/cli.ts` | `createProvider()` 统一 `new ProviderClass(config)`，但各 provider 构造签名并不一致；运行时参数注入错误，类型系统也没有兜住 |
| 6.3 | Provider mode 枚举词面分叉 | `src/providers/types.ts`, `src/ipc.ts`, `tests/config.test.ts` | 当前同时存在 `agent-read`、`agent-readonly` 等词面，跨层语义不一致，容易在 orchestration / IPC / tests 中产生隐性分支错误 |
| 6.4 | TS / Python IPC 不是 single source of truth | `src/ipc.ts`, `scripts/task_runner.py`, `tests/ipc-schema.test.ts` | TypeScript 侧严格校验 schema/version，Python 侧实际 payload/result 字段、状态值、解析规则已经漂移，协议声明与运行时实现脱节 |
| 6.5 | Python runner 已退化成 simulated executor，主执行链语义断裂 | `scripts/task_runner.py`, `scripts/watcher.sh`, `src/providers/cli.ts` | runner 目前不再稳定承担“真实执行 provider command + stdout 透传 + patch 收集/应用”的职责，导致 agent 主链与 watcher/smoke 契约失真 |

## P1 — 生命周期 & 编排正确性

| # | 问题 | 文件 | 说明 |
|---|------|------|------|
| 6.6 | Workspace 生命周期与 checkpoint/resume 语义冲突 | `src/tools/run-pipeline.ts`, `src/workspace.ts`, `src/state.ts` | checkpoint 持久化了 worktree 元数据，但 `finally` 又无条件销毁 workspace，resume 可能指向已经不存在的 worktree |
| 6.7 | Review verdict 存在多套判定逻辑 | `src/scheduler.ts`, `src/verdict.ts`, `src/prompt.ts` | 运行态不应再靠 substring / 旁路逻辑判定是否 approved，必须统一走结构化 verdict parser |
| 6.8 | 缺少显式的 “step kind -> prompt builder -> response parser” 策略层 | `src/scheduler.ts`, `src/prompt.ts` | generate/review 等步骤行为被硬塞进同一条 prompt 流程，prompt 体系与步骤职责没有清晰边界 |
| 6.9 | 动态 DAG 注入的缓存失效机制是假的 | `src/tools/run-pipeline.ts`, `src/config.ts` | 运行时修改 `config.pipeline` 后试图通过对象字段清理 DAG cache，但真实缓存存在于模块级变量中，扩图行为不可靠 |
| 6.10 | Trace 生命周期没有真正接入主流程 | `src/trace.ts`, `src/tools/run-pipeline.ts`, `src/tools/race.ts` | trace 需要明确的 `create -> record -> update -> finalize` 生命周期；当前主链、race、state 的 trace 语义并未收口 |
| 6.11 | 全局超时取消和后台执行终止需要做成真实契约 | `src/tools/run-pipeline.ts`, `src/providers/cli.ts` | 编排层 timeout 不应只是抛错返回，必须保证后台 provider / runner / worktree 生命周期一并被取消并收口 |
| 6.12 | 锁语义必须明确成“默认独占，显式共享” | `scripts/workspace_manager.py`, `src/workspace.ts` | repo lock/shared lock 的策略要成为明确 contract，不能让普通 pipeline 因默认 key 归一而意外共享同一仓库锁 |

## P2 — 类型系统 & 工程边界

| # | 问题 | 文件 | 说明 |
|---|------|------|------|
| 6.13 | orchestration 核心层仍有 `any` 泄漏 | `src/config.ts`, `src/scheduler.ts`, `src/state.ts` | `any` 已经进入 provider factory、dynamic pipeline、trace 等关键边界，说明模型没有真正收口 |
| 6.14 | 任务/结果落盘需要统一成原子写协议 | `src/providers/cli.ts`, `scripts/watcher.sh` | task/result 文件应统一使用 `tmp + rename`，避免 watcher 或 runner 读到半写 JSON |
| 6.15 | shell / runner / workspace_manager / TS orchestrator 的 ownership 不清晰 | `scripts/watcher.sh`, `scripts/task_runner.py`, `scripts/workspace_manager.py`, `src/workspace.ts` | 现在四层都在碰执行、锁、worktree、清理，职责边界过于模糊，后续会持续制造双写和分叉逻辑 |
| 6.16 | `CLIProvider` 在异常路径上破坏 discriminated union | `src/providers/cli.ts`, `src/providers/types.ts` | 当前失败分支会返回错误的 response shape，导致上层对 text/agent 的分支判断不再可信 |

## P3 — 运行时依赖 & 验证基线

| # | 问题 | 文件 | 说明 |
|---|------|------|------|
| 6.17 | 运行时依赖边界不干净 | `src/ast_utils.ts`, `src/scheduler.ts`, `package.json` | 运行期导入链依赖 `typescript` 这类目前放在 `devDependencies` 的包，生产安装 runtime deps 时存在直接崩溃风险 |
| 6.18 | 失败路径验证仍不完整 | `tests/*` | 至少需要补齐锁冲突、checkpoint resume、patch apply 冲突、watcher/runner 异常退出等失败路径测试，作为地基重构的验收线 |

