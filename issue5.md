# Phase 5 Review — 完整清单

## P0 — IPC 合约 & 安全

| # | 问题 | 文件 | 说明 |
|---|------|------|------|
| 5.1 | Python `TaskResult.to_dict()` 缺少 `insights` 和 `nextSteps` 字段 | `scripts/task_runner.py:94` | IPC 合约断裂：TS 侧 `TASK_RESULT_FIELDS` 已包含这两个字段，Python 侧序列化时丢弃，导致动态 DAG 扩展和知识传递在 CLI provider 路径下静默失效 |
| 5.2 | `run_git_diff` 三个 `subprocess.check_output` 无 timeout | `scripts/task_runner.py:111-113` | 大仓库 diff 可能永久挂起，阻塞整个 pipeline |
| 5.3 | `state.ts` `dynamicPipeline` 类型为 `Record<string, any[]>` | `src/state.ts:102` | 应为 `Record<string, [string \| string[], ...string[]]>` 与 `PipelineConfig.pipeline` 一致 |

## P1 — 类型安全 & Dead Code

| # | 问题 | 文件 | 说明 |
|---|------|------|------|
| 5.4 | `serializeResponse` 返回 `any` | `src/tools/helpers.ts:156` | 应定义返回类型（`Record<string, unknown>` 或具体 shape） |
| 5.5 | `race.ts` 中 `c: any` 类型断言 | `src/tools/race.ts:59` | 应给 `RaceSession.candidates` 元素定义接口 |
| 5.6 | `query-traces.ts` 中 `status as any` | `src/tools/query-traces.ts:25` | Zod schema 与 `queryTraces` 参数类型不匹配，应对齐 |
| 5.7 | `renderPromptTemplate` 是 `renderPrompt` 的无用包装 | `src/prompt.ts:231` | 定义了但从未被导入使用，直接删除 |
| 5.8 | `orchestration/multi-agent-types.ts` 全部导出无消费者 | `src/orchestration/multi-agent-types.ts` | 纯脚手架代码，未接入任何模块，应删除或标记为 WIP |

## P2 — 可观测性 & 一致性

| # | 问题 | 文件 | 说明 |
|---|------|------|------|
| 5.9 | 11 处 `console.error/warn` 未迁移到 structured logger | `state.ts(3)`, `trace.ts(1)`, `workspace.ts(1)`, `index.ts(4)`, `openai.ts(2)` | Phase 4 引入了 `logger.ts`，但这些遗留调用仍直接写 stderr，格式不统一 |
| 5.10 | `typescript` 在 `dependencies` 而非 `devDependencies` | `package.json:16` | 运行时不需要 tsc，应移到 devDependencies |

## P3 — 项目卫生

| # | 问题 | 文件 | 说明 |
|---|------|------|------|
| 5.11 | `.gitignore` 缺少 `__pycache__/` 和 `*.pyc` | `.gitignore` | Python 脚本会产生字节码缓存，应排除 |
