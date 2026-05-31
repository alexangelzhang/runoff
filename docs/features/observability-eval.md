# Experiment 查询与导出

> 模块总览见 [`observability.md`](features/observability.md)。本文只说明 **Experiment** 分支。

在 Phase 8.3 链路（`trace` → `experiments.jsonl` → `experiment-judge`）上增加：

- **eval-report**：variant 汇总 + 推荐 winner
- **dataset**：可复现 JSONL（schema `llm-pipeline-eval-v1`）

## 写入（自动）

每次 `llm_run_pipeline` 结束（含失败），`PipelineHooks` 会：

1. 用 prompt 哈希作为 `experimentId`
2. 用 prompt+config 哈希作为 `variant`
3. 若有同 experiment 的已 approved baseline，则 `judgeExperiment` 打 `keep` / `discard` / `regression`

日志路径：`~/.llm-pipeline/experiments.jsonl`

## MCP：`llm_query_experiments`

| `format` | 需要 `experimentId` | 输出 |
|----------|---------------------|------|
| `entries`（默认） | 否（可过滤） | 原始行 |
| `summary` | 是 | 按 variant 聚合 |
| `eval-report` | 是 | winner + `recommendation` |
| `dataset` | 是 | 写入 `~/.llm-pipeline/datasets/<id>.jsonl` + 预览 |

### 示例

```json
{ "experimentId": "<id>", "format": "eval-report" }
```

```json
{ "experimentId": "<id>", "format": "dataset" }
```

`experimentId` 可从某次 trace 的 `experiment.experimentId` 读取，或对同一 prompt 连跑几次后在 `entries` 里观察。

## 实现

- `src/observability-dataset.ts` — 行格式与报告
- `src/experiment-log.ts` — 追加与查询
- `src/orchestration/experiment-judge.ts` — 判定规则
