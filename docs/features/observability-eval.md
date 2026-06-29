# Experiment 查询与导出

> 模块总览见 [`observability.md`](features/observability.md)。本文只说明 **Experiment** 分支。

在 Phase 8.3 链路（`trace` → `experiments.jsonl` → `experiment-judge`）上增加：

- **eval-report**：variant 汇总 + 推荐 winner
- **dataset**：可复现 JSONL（schema `runoff-eval-v1`）

## 写入（自动）

每次 `runoff_run_pipeline` 结束（含失败），`PipelineHooks` 会：

1. 用 prompt 哈希作为 `experimentId`
2. 用 prompt+config 哈希作为 `variant`
3. 若有同 experiment 的已 approved baseline，则 `judgeExperiment` 打 `keep` / `discard` / `regression`

日志路径：`~/.runoff/experiments.jsonl`

## MCP：`runoff_query_experiments`

| `format` | 需要 `experimentId` | 输出 |
|----------|---------------------|------|
| `entries`（默认） | 否（可过滤） | 原始行 |
| `summary` | 是 | 按 variant 聚合 |
| `eval-report` | 是 | winner + `recommendation` |
| `dataset` | 是 | 写入 `~/.runoff/datasets/<id>.jsonl` + 预览 |

### 示例

```json
{ "experimentId": "<id>", "format": "eval-report" }
```

```json
{ "experimentId": "<id>", "format": "dataset" }
```

`experimentId` 可从某次 trace 的 `experiment.experimentId` 读取，或对同一 prompt 连跑几次后在 `entries` 里观察。

## Stage-level evaluation hints

End-to-end `approved` / `failed` 不足以解释一个 agentic pipeline 的质量。runoff 现在用 `src/observability/stage-evaluation.ts` 提供轻量 metric taxonomy，先作为 `PipelineObservation.stageEvaluations` 的提示字段，不阻塞主链路。

| Stage kind | 典型 step 名 | 指标例子 |
| ---------- | ------------ | -------- |
| `analyze` | `analyze` | `scope_accuracy`、`risk_identification`、`test_target_precision` |
| `implement` | `implement`、`refactor`、`write` | `diff_validity`、`surface_compliance`、`boundary_handling` |
| `review` | `review` | `evidence_citation`、`blocker_separation`、`false_positive_control` |
| `test` | `test`、`verify` | `command_capture`、`exit_status`、`output_summary` |
| `final_summary` | `final`、`summary`、`report` | `claim_evidence_coverage`、`unverified_items_visible`、`trace_ref_present` |

`eval-report` 现在返回 `stageEvaluationSummary`：

- `evaluatedTraceCount`：有 `PipelineObservation.stageEvaluations` 的 trace 数。
- `stageEvaluationCount`：聚合到的 stage hint 数。
- `missingTraceCount`：experiment entry 指向的 trace 文件缺失数。
- `missingStageEvaluationCount`：trace 存在但没有 stage hints 的 run 数。
- `byKind`：按 `analyze` / `implement` / `review` / `test` / `final_summary` / `other` 汇总 step 名、metric 名和 evidence refs。

这些字段只做报告和缺口统计，不自动判定 pass/fail。harness evolution gate 后续可以消费同一份 taxonomy。

## 实现

- `src/observability/observability-dataset.ts` — 行格式、报告、stage evaluation summary
- `src/observability/experiment-log.ts` — 追加与查询
- `src/orchestration/experiment-judge.ts` — 判定规则
- `src/observability/stage-evaluation.ts` — stage-level metric hint taxonomy
