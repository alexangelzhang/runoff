# 可观测模块（本地、轻量）

> **定位**：借鉴 **LangSmith、LangFuse、Phoenix** 等产品的**思路**（非 SDK/SaaS 接入），在 **llm-pipeline 自有存储与 MCP** 内做轻量闭环。

## 要回答的三个问题

| 问题 | 模块 | 存储 / 入口 |
|------|------|-------------|
| 单次 pipeline 发生了什么？ | **Trace** | `~/.llm-pipeline/traces/` · MCP `llm_query_traces` |
| 同一任务多配置/多 prompt 谁更好？ | **Experiment** | `~/.llm-pipeline/experiments.jsonl` · MCP `llm_query_experiments` |
| 可选：给外部脚本或人工复盘？ | **Dataset 导出** | `~/.llm-pipeline/datasets/<experimentId>.jsonl` |

成本与跨进程追踪（已有、非本模块核心）：

- `trace.costSummary`、`CostGovernor` — pipeline 级花费
- `runtime.otelExport` — 可选 OTLP，默认关

## 数据流（主路径）

```
llm_run_pipeline
  → PipelineHooks
       ├─ persistRunningPipelineTrace / recordTrace     (trace, lifecycle: running|final)
       ├─ appendExperimentEntry + judgeExperiment      (experiments.jsonl, 仅同 prompt 族)
       ├─ pattern-cache / memory feedback              (成功 run 学习，非查询面)
       └─ otelExport?                                  (可选)
  → llm_query_traces / llm_query_experiments            (MCP 只读分析)
```

详见 [`trace-lifecycle.md`](trace-lifecycle.md)、[`observability-eval.md`](observability-eval.md)。

## 代码地图（刻意保持小）

| 职责 | 文件 |
|------|------|
| Trace 读写/聚合 | `src/trace.ts` |
| 实验 JSONL + 按 variant 汇总 | `src/experiment-log.ts` |
| keep/discard 规则 | `src/orchestration/experiment-judge.ts` |
| 数据集行 + eval 报告 | `src/observability-dataset.ts` |
| 挂钩编排 | `src/pipeline-hooks.ts` |
| MCP | `src/tools/query-traces.ts`、`src/tools/query-experiments.ts` |

**不单独再拆「观测微服务」**；新能力优先落在上述文件，避免 parallel 抽象层。

## 借鉴谁、借什么（概念对照）

两家都适合做**产品思路**参考，本仓库只取与 MCP pipeline 主链重合的部分。

| 概念 | LangSmith 侧重 | LangFuse 侧重 | 本仓库对应 | 状态 |
|------|----------------|---------------|------------|------|
| 单次运行记录 | Run / Run tree | Trace + Observation 层级 | `PipelineTrace` + `StepTrace` + `spanId` | ✅ 已有 |
| 花费 | Token/cost 报表 | Generation 级 cost | `totalUsage`、`costSummary`、step `usage` | ✅ 已有 |
| 实验 / 对比 | Datasets、Experiments | Datasets、Eval runs | `experiments.jsonl` + `eval-report` | ✅ TOP1 |
| 自动评分 | Evaluators | Scores（含模型/人工） | `judgeExperiment` → `judgeScores` | ✅ 自动；人工分未做 |
| Prompt 版本 | Prompt hub | Prompt 管理 + 关联 trace | `prompt-version.ts`、`StepTrace.promptVersionId` | ✅ 已有 |
| 会话聚合 | Projects | **Session**（多 trace 一组） | checkpoint `sessionId`；trace 文件未统一按 session 索引 | ⚠️ 部分（可按需小补） |
| 标签过滤 | Metadata | **Tags** on trace | `ExperimentMeta.tags`；trace 级 tags 可扩展 | ⚠️ 实验侧有 |
| 嵌套 span | 较完整 | Observation 树 | 扁平 `steps[]` + 可选 OTel 导出 | 够用即可，不追全树 |
| UI 工作台 | 强 | 强 | MCP JSON 查询 | ❌ 刻意不做 |

**LangFuse 值得多借的一点**：把「**Score**」想成对某次 run 的显式评价（不仅自动 judge）——若以后要加，最小形态是 `traceId` + 数值/备注 追加进 JSONL，不必接 LangFuse API。

**LangSmith 值得多借的一点**：**Dataset 行 ↔ Run** 一一对应、便于离线复现——已由 `llm-pipeline-eval-v1` + `traceId` 字段覆盖。

## 明确不做（非目标）

| 不做 |
|------|
| LangSmith / **LangFuse** / Phoenix / Arize **托管或官方 SDK 接入** |
| 全链路 Web UI、协作评审台 |
| 在线 prompt playground |
| 与 pipeline 无关的通用 Observation 语义层（除非 OTel 已够用） |

## MCP 用法摘要

**Trace**

```json
{ "status": "failed", "limit": 20, "aggregate": true }
```

**Experiment**（需先有多轮 `llm_run_pipeline`，同 prompt 会共享 `experimentId`）

```json
{ "experimentId": "<id>", "format": "eval-report" }
```

```json
{ "experimentId": "<id>", "format": "dataset" }
```

`variant` 由 hooks 根据 prompt+config 哈希生成；改 config 即新 variant，适合 A/B。

## 扩展原则（若还要加）

只加能直接服务上表三个问题的能力，例如：

- 按 `experimentId` 关联回 `trace` 全文（eval-report 里带 trace 摘要）— 小改即可
- 失败 run 的固定「复盘模板」输出 — 文档或 MCP 格式，不必新存储

避免：新配置文件层、与 pipeline 主链无关的 dashboard、重复造 trace 存储。

## 若只从 LangFuse 再收一小步（可选、仍本地）

优先级低，且都应落在现有三个 MCP/文件上：

1. **Session 视图**：`llm_query_traces` 增加按 `sessionId`（来自 checkpoint 或 hooks 写入 trace）过滤——只读聚合，无新存储。
2. **人工 Score**：对指定 `traceId` 追加一条 score 到 sidecar JSONL（与 `experiments.jsonl` 并列），eval-report 可引用。

未写进代码前，以上仅为边界内扩展建议，不是承诺交付。
