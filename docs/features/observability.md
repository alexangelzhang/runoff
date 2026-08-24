# 可观测模块（本地、轻量）

> **定位**：借鉴 **LangSmith、LangFuse、Phoenix** 等产品的**思路**（非 SDK/SaaS 接入），在 **runoff 自有存储与 MCP** 内做轻量闭环。  
> **我们不是** LangSmith/Langfuse 的 UI 或托管替代 — 见下文「明确不做」。

## 要回答的三个问题

| 问题                              | 模块             | 存储 / 入口                                                    |
| --------------------------------- | ---------------- | -------------------------------------------------------------- |
| 单次 pipeline 发生了什么？        | **Trace**        | `~/.runoff/traces/` · MCP `runoff_query_traces`                |
| 同一任务多配置/多 prompt 谁更好？ | **Experiment**   | `~/.runoff/experiments.jsonl` · MCP `runoff_query_experiments` |
| 可选：给外部脚本或人工复盘？      | **Dataset 导出** | `~/.runoff/datasets/<experimentId>.jsonl`                      |

成本与跨进程追踪（已有、非本模块核心）：

- `trace.costSummary`、`CostGovernor` — pipeline 级花费
- `runtime.otelExport` — 可选 OTLP，默认关

## 数据流（主路径）

```
runoff_run_pipeline
  → PipelineHooks
       ├─ persistRunningPipelineTrace / recordTrace     (trace, lifecycle: running|final)
       ├─ appendExperimentEntry + judgeExperiment      (experiments.jsonl, 仅同 prompt 族)
       ├─ pattern-cache / memory feedback              (成功 run 学习，非查询面)
       └─ otelExport?                                  (可选)
  → runoff_query_traces / runoff_query_experiments            (MCP 只读分析)
```

详见 [`trace-lifecycle.md`](architecture/trace-lifecycle.md)、[`observability-eval.md`](features/observability-eval.md)。

## 代码地图（刻意保持小）

| 职责                         | 文件                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| Trace 读写/聚合              | `src/observability/trace.ts`                                                              |
| Postmortem + drift           | `src/observability/trace-postmortem.ts`                                                   |
| 人工 scores                  | `src/observability/trace-scores.ts`                                                       |
| 实验 JSONL + 按 variant 汇总 | `src/observability/experiment-log.ts`                                                     |
| keep/discard 规则            | `src/orchestration/experiment-judge.ts`                                                   |
| 数据集行 + eval 报告         | `src/observability/observability-dataset.ts`                                              |
| Stage-level metric hints     | `src/observability/stage-evaluation.ts`                                                   |
| 挂钩编排                     | `src/pipeline/pipeline-hooks.ts`                                                          |
| 本地 UI                      | `src/pipeline/observability-ui-server.ts`                                                 |
| MCP                          | `src/tools/query-traces.ts`、`src/tools/query-experiments.ts`、`src/tools/score-trace.ts` |

**不单独再拆「观测微服务」**；新能力优先落在上述文件，避免 parallel 抽象层。

## 借鉴谁、借什么（概念对照）

两家都适合做**产品思路**参考，本仓库只取与 MCP pipeline 主链重合的部分。

| 概念         | LangSmith 侧重        | LangFuse 侧重                                    | 本仓库对应                                                          | 状态                |
| ------------ | --------------------- | ------------------------------------------------ | ------------------------------------------------------------------- | ------------------- |
| 单次运行记录 | Run / Run tree        | Trace + Observation 层级                         | `PipelineTrace` + `StepTrace` + `spanId`                            | ✅ 已有             |
| 花费         | Token/cost 报表       | Generation 级 cost                               | `totalUsage`、`costSummary`、step `usage`                           | ✅ 已有             |
| 实验 / 对比  | Datasets、Experiments | Datasets、Eval runs                              | `experiments.jsonl` + `eval-report`                                 | ✅ TOP1             |
| 自动评分     | Evaluators            | Scores（含模型/人工）                            | `judgeExperiment` → `judgeScores`                                   | ✅ 自动；人工分未做 |
| Prompt 版本  | Prompt hub            | Prompt 管理 + 关联 trace                         | `prompt-version.ts`、`StepTrace.promptVersionId`                    | ✅ 已有             |
| 会话聚合     | Projects              | **Session**（多 trace 一组）                     | `PipelineTrace.sessionId` + `runoff_query_traces` / CLI `--session` | ✅                  |
| 标签过滤     | Metadata              | **Tags** on trace                                | `ExperimentMeta.tags`；trace 级 tags 可扩展                         | ⚠️ 实验侧有         |
| 嵌套 span    | 较完整                | Observation 树                                   | 扁平 `steps[]` + 可选 OTel 导出                                     | 够用即可，不追全树  |
| UI 工作台    | 强                    | 强                                               | 本地 `pipeline observability ui`（简易，可扩展）                    | ✅ 基础版           |
| 人工 Score   | Scores                | `traces/scores.jsonl` + MCP `runoff_score_trace` | ✅                                                                  |
| 失败复盘     | —                     | `format=postmortem` + drift 提示                 | ✅ `trace-postmortem.ts`                                            |

## Observation layer

Each completed pipeline step now stores a deterministic `StepResult.observation` next to the raw step result. `PipelineResult.observation` gives the same work-memory view at the run boundary, including pause/failure next actions. These fields are host/model work memory for the next turn, not the audit log.

| Field                        | Purpose                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `schemaVersion`              | Pins the observation contract for host parsing.                                             |
| `action` / `purpose`         | Identifies the runtime event and why it is being returned to the host.                      |
| `status` / `summary`         | Gives the next reasoning turn a short, stable outcome.                                      |
| `evidence`                   | Lists concrete fields such as provider, model, modified files, diff stat, reason, or error. |
| `coverageGaps`               | Names missing or incomplete coverage without hiding the raw result.                         |
| `typedCoverageGaps`          | Classifies gaps as `process`, `evidence`, or `draft` so reflection is not one bucket.        |
| `artifactRefs` / `stepRefs`  | Points back to complete step output without inlining all raw material.                      |
| `claims`                     | Maps concise claims back to artifact refs, trace refs, or structured evidence fields.        |
| `contextContract`            | States which context inputs were expected, which were forbidden, and what evidence is required. |
| `scopePreflight`             | Pipeline-level preflight report for workDir, dirty worktree, docs scope, verification, race, and approval assumptions. |
| `resumeMetadata`             | Step-level resume contract: input hash, artifact completeness, provider result presence, workspace attachment, and rerun/skip hints. |
| `resumeReusePlan`            | Pipeline-level resume planner report: skipped/rerun decisions, downstream invalidation, and evidence refs. |
| `stageEvaluations`           | Pipeline-level hints for stage-specific metrics such as analyze / implement / review / test. |
| `traceRef` / `checkpointRef` | Keeps run-level audit and resume pointers close to the summary.                             |

`observation` is generated by code templates from structured runtime data. It does not replace `artifacts` or `traces`; artifacts keep full step output, and traces remain the durable audit/eval record.

### PRINCE P1 contract scaffolding

PRINCE's useful lesson for runoff is contract discipline, not a new hosted stack. The observation schema now has optional fields for four P1 contracts:

| Contract | Runtime surface | Boundary |
| -------- | --------------- | -------- |
| Step Context Contract | `StepResult.contextContract` → `StepObservation.contextContract` | Optional metadata; old configs keep running. |
| Reflection Taxonomy | `typedCoverageGaps.kind = process | evidence | draft` | Keeps existing string `coverageGaps` for compatibility. |
| Claim-level Evidence | `claims[].evidenceRefs` | Uses artifact refs when available, otherwise structured evidence strings; MCP JSON and CLI run hints expose these refs for final summaries / PR comments. |
| Stage-level Evaluation | `PipelineObservation.stageEvaluations` from `stage-evaluation.ts` | Metric hints only; `eval-report.stageEvaluationSummary` aggregates them and reports missing trace / missing hint counts. |

When hosts or reviewers classify a claim gap, prefer this split (aligned with generic Agent Runtime checklists — see [harness-vs-loop.md §Agent Runtime checklist](../guides/harness-vs-loop.md#agent-runtime-checklist-borrow--skip)):

| Gap kind | Meaning | Suggested next action |
| -------- | ------- | --------------------- |
| **insufficient** | Claim lacks supporting evidence refs | Re-gather context / mark uncertain — do not invent |
| **contradiction** | Evidence explicitly conflicts with the claim | Rewrite, block, or escalate — do not soft-overwrite |

Today this is **vocabulary for hosts and future gates**, not a required enum on `claims[]`. `typedCoverageGaps.kind = evidence` remains the shipped taxonomy bucket.

The first implementation intentionally reports gaps instead of enforcing them. Future gates can consume these fields when a profile wants stricter behavior.

### PRINCE P2/P3/P4 runtime contracts

P2 adds two runtime contracts; P3 starts consuming the resume contract in the runner; P4 exposes those runtime reuse decisions as structured evidence:

| Contract | Runtime surface | Boundary |
| -------- | --------------- | -------- |
| Clarify as Scope Preflight | `PipelineResult.scopePreflight` + `PipelineObservation.scopePreflight` + `status: "needs_clarification"` | May pause before step execution; resume with same `sessionId` and explicit `scopePreflight` confirmations. |
| Step-level Resume Metadata | `StepResult.resumeMetadata` → `StepObservation.resumeMetadata` → `StepTrace.resumeMetadata` | Records can-skip/must-rerun evidence for each completed step. |
| Resume Reuse Planner | `applyResumeStepReusePlan` inside `runPipelineDAGLoop` | On same-round resume, completed steps with `canSkipOnResume=false` are queued for rerun; completed downstream steps are invalidated transitively. Legacy completed steps without `resumeMetadata` remain skippable for compatibility. |
| Resume Reuse Plan Observability | `PipelineResult.resumeReusePlan` → `PipelineObservation.resumeReusePlan` → `PipelineTrace.resumeReusePlan` + `PipelineState.resumeReusePlan` | Lets host agents and offline audit inspect skipped/rerun decisions without scraping logs. Rerun decisions also appear as process `typedCoverageGaps`. |

`runtime.scopePreflight` can make dirty worktree, docs update, race, or verification-command checks warn or require clarification. The MCP parameter `scopePreflight` is the per-run override channel for explicit operator confirmation.

Host agents should read observation fields in this order:

1. Parse the MCP JSON body and inspect `PipelineResult.observation.status` / `nextHint`.
2. If status is `needs_clarification`, answer `scopePreflight.clarificationQuestions` before running steps.
3. On resumed runs, inspect `PipelineResult.observation.resumeReusePlan` before trusting reused outputs; rerun entries explain stale artifact or downstream invalidation decisions.
4. Inspect the referenced `stepRefs` and `stepResults.<step>.observation` for step-local evidence, coverage gaps, and `resumeMetadata`.
5. Follow `artifactRefs`, `traceRef`, or `checkpointRef` only when full material, audit history, or resume state is needed.

On checkpoint resume, the runner may rewrite an already-completed same-round step back to `queued` when its `resumeMetadata` says the artifact is incomplete or the provider result is unsafe to reuse. If that step is upstream of other completed steps, those downstream results are also queued for rerun so review/test/final-summary steps do not reuse stale output.

CLI outcome hints summarize the resume planner as `rerun=N, skipped=M`. They list `rerun` entries first, include `downstreamOf=<step>` for invalidated downstream work, and keep skipped entries folded behind `resumeReusePlan` audit/debug inspection so routine host output stays focused on work that was actually re-executed.

`runoff_query_runs` with `format: "full"` also exposes a compact `resumePlanner` summary on each returned run when available. This summary mirrors the same display policy: `rerunSteps` are explicit, `downstreamOf` is included for invalidated downstream work, and skipped steps are represented by `skipped` / `skippedHidden` counts rather than expanded by default.

Summary/list format (`format: "summary"`) adds a compact mark only: `resumePlanner: { rerun, skipped }` in JSON, or `resume=rerun:N,skipped:M` in CLI list output — no step details or evidence refs.

### Resume planner host consumption order

When a host agent or operator inspects a **resumed** run, read resume planner evidence in this order (first hit wins for display; deeper layers remain for audit):

| Priority | Source | When to use |
| -------- | ------ | ----------- |
| 1 | `PipelineResult.resumeReusePlan` | Immediate MCP `runoff_run_pipeline` response after resume |
| 2 | `PipelineResult.observation.resumeReusePlan` | Same response when top-level field omitted; work-memory mirror |
| 3 | `runoff_query_runs` `format=full` → `run.resumePlanner` | Control-plane / durable run record; compact rerun list + counts |
| 4 | `PipelineTrace.resumeReusePlan` (`runoff_query_traces`, `pipeline traces show`) | Offline audit, postmortem, experiment eval |
| 5 | Checkpoint `resumeReusePlan` (`~/.runoff/sessions/<session>.checkpoint.json`) | Resume state before next run starts |

**Display policy (all surfaces):** rerun entries expanded with `stepName`, `reason`, and `downstreamOf` when present; skipped entries collapsed by default; full skipped audit via `--json`, trace JSON, or checkpoint.

**Standard host text templates**

Has rerun (EN):
```
Resume planner (round R): rerun=N, skipped=M
• rerun <step>: <reason> [downstreamOf=<upstream>]
Skipped audit: M step(s) — expand resumeReusePlan / trace / checkpoint for details.
```

Has rerun (中文):
```
恢复规划（第 R 轮）：重跑 N 步，跳过 M 步
• 重跑 <step>：<reason> [下游=<upstream>]
跳过审计：M 步 — 展开 resumeReusePlan / trace / checkpoint 查看详情。
```

Only skipped, no rerun (EN):
```
Resume planner (round R): all completed steps reused (skipped=M). No reruns required.
Audit: inspect resumeReusePlan for evidence refs.
```

Only skipped, no rerun (中文):
```
恢复规划（第 R 轮）：已完成步骤均可复用（跳过 M 步），无需重跑。
审计：查看 resumeReusePlan 中的 evidenceRefs。
```

No resumePlanner fallback (EN):
```
No resume planner on this run (fresh start or pre-planner checkpoint). Trust stepResults / trace for reuse evidence.
```

No resumePlanner fallback (中文):
```
本 run 无 resume planner（全新启动或旧 checkpoint）。复用证据请查 stepResults / trace。
```

**Host conversation UX:** This section documents fields, surfaces, and read-model priority. For how MCP hosts should *explain* resumed runs to users (decision matrix, bilingual templates, anti-patterns, evidence drilldown), see **[Host resume UX](../guides/host-resume-ux.md)**.

Trace postmortems and experiment eval reports surface `observationSummary` so offline review can compare what the host saw with the raw artifact/trace record. CLI run outcome hints also print claim evidence refs when `PipelineResult.observation.claims` is present.

## Harness evolution control plane

The harness-evolution control plane (`runoff_harness_evolve`, `npm run runoff:harness`) was extracted into the standalone, host-agnostic `agent-evolution` project and is no longer part of runoff. Trigger scans, dataset splits, orchestrated runs, role policy evidence, run reports, candidate lineage, leakage audit, frontier state, and promotion bundles now persist under that project's artifact root.

Capability maturity is explicit: core pipeline execution, local harness artifacts, artifact indexing, and artifact-store doctor checks are implemented; paddock, sandbox, rollout, connector, and training-export objects are stable adapter contracts unless a concrete adapter is configured. Harness reports and promotion bundles are audit material by default and do not apply edits to user repositories.

| Capability                         | Mechanism                                                                                                                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failure signature mining           | `mine` clusters failed traces into `failure-signatures/<id>.json` with evidence traces, suspected harness surface, and suggested editable surface                                                                                      |
| Trigger runtime                    | `trigger_scan` evaluates explicit rules such as `trace_failure`, `audit_blocker`, and `frontier_stagnation`; it writes trigger events and pending plans without default source edits                                                   |
| Dataset / split object             | `dataset` writes `datasets/<datasetId>.json` with held-in and held-out trace items, source signatures, and leakage terms                                                                                                               |
| Dataset evaluation                 | `evaluate_dataset` maps every dataset baseline trace to a candidate trace, runs the held-in/held-out gate, and writes `datasets/<datasetId>/evaluations/<candidateId>.json`                                                            |
| Evolution plan / run / report      | `run` writes `runs/<runId>/plan.json`, `run.json`, and `report.json`; `report` exposes status, next action, missing candidate trace mappings, and artifact refs                                                                        |
| Role policy evidence               | `run` records builder/reviewer/verifier provider separation and blocks automatic acceptance when configured independence is not met                                                                                                    |
| Connector writeback                | `writeback` writes local Markdown or JSONL report artifacts for CI, PR comments, or external systems to consume later                                                                                                                  |
| Artifact store index / doctor      | `index` returns typed counts and JSON validity for local harness artifacts; `doctor` returns health status, invalid artifact warnings, and the next control-plane action                                                                |
| Change manifest + lineage          | Candidate records under `candidates/<id>/manifest.json` and `candidate.json` track editable surface, expected fixes, parent candidates, mined signatures, and dataset IDs                                                              |
| Variant isolation                  | Optional source directory copied to an isolated candidate `variant/` directory                                                                                                                                                         |
| Automatic proposer                 | `propose` invokes a configured provider with `workDir` set to the isolated `variant/`, includes mined signatures plus `history-context.json`, records `proposal.json`, and flags files outside `editableSurface`                       |
| Observed variant diff              | `propose` snapshots the candidate `variant/` before/after provider execution and records `observedFilesModified`, `observedDiffStat`, `unreportedFilesModified`, and `reportedButUnchangedFiles`                                       |
| Leakage / overfit audit            | `audit` writes `candidates/<id>/audit.json`; it blocks missing/failed proposals, surface violations, unreported edits, empty diffs, and leakage terms from explicit inputs or held-out dataset IDs/signatures                          |
| Held-in / held-out regression gate | `evaluate` compares baseline/candidate trace pairs and requires both splits, zero regressions, and at least one measured improvement                                                                                                   |
| Coreset selection                  | `coreset` ranks difficult traces while preserving diversity keys                                                                                                                                                                       |
| Self-preference rank               | `rank` performs deterministic pairwise preference over gate results                                                                                                                                                                    |
| Frontier                           | `frontier` writes `frontiers/<frontierId>.json` with rank, gate, audit, lineage, accepted, and rejected candidate state                                                                                                                |
| Acceptance guard / rollback audit  | `decide` accepts only when proposal is clean, observed diff exists, audit passed, role policy passed when configured, and held-in/held-out gate passed; otherwise it rolls back or blocks forced accept without mutating the user repo |
| Promotion bundle                   | `export` writes `promotion/bundle.json` plus copied observed variant files for accepted candidates only                                                                                                                                |

Proposers edit only candidate variant directories. A full `run` can orchestrate coreset, mining, dataset creation, proposal, dataset evaluation, audit, role-policy enforcement, rank/frontier, decision, connector writeback, and optional export; when candidate trace mappings are missing it stops at `awaiting_candidate_traces` with an explicit `nextAction` instead of inventing evaluation evidence.

**LangFuse 借鉴已落地**：`traces/scores.jsonl` 记录 `traceId` + 数值/备注；eval-report 的 `traceInsights` 带一行 postmortem 摘要。

**LangSmith 值得多借的一点**：**Dataset 行 ↔ Run** 一一对应、便于离线复现——已由 `runoff-eval-v1` + `traceId` 字段覆盖。

## 明确不做（非目标）

| 不做                                                               |
| ------------------------------------------------------------------ |
| LangSmith / **LangFuse** / Phoenix / Arize **托管或官方 SDK 接入** |
| 全功能协作评审台、多租户 SaaS 观测台                               |
| 在线 prompt playground                                             |
| 与 pipeline 无关的通用 Observation 语义层（除非 OTel 已够用）      |

## Optional OTLP export

Off by default. Enable in `pipeline.config.json`:

```json
{
  "runtime": {
    "otelExport": true,
    "otelEndpoint": "http://127.0.0.1:4318/v1/traces"
  }
}
```

Or set environment variable `OTEL_EXPORTER_OTLP_ENDPOINT` (see `src/observability/trace-exporter.ts`).

Spans are derived from pipeline/step traces at end of run — suitable for Jaeger, Grafana Tempo, or any OTLP HTTP collector.

**Self-hosted collector（pre-release / 本地）** — 详见 [`observability-collector-local.md`](operations/observability-collector-local.md)

不强制 Docker：Homebrew / 官方二进制下载 / 公司已有 Collector URL / Docker 仅作兜底。

```bash
# 个人试用（无 Docker）
brew install opentelemetry-collector   # macOS 可选
RUNOFF_OTEL_DOWNLOAD=1 npm run otel-collector:start
npm run verify:otel-collector:local

# 仅连公司已有 Collector
export OTEL_EXPORTER_OTLP_ENDPOINT=https://internal-collector:4318
export RUNOFF_OTEL_SKIP_START=1
RUNOFF_OTEL_COLLECTOR_REQUIRED=1 npm run verify:otel-collector
```

CI：`verify:otel-export` 必过；`verify:otel-collector` 无 listener 时 SKIP。pre-release 用 `otel-collector.sh start` + `RUNOFF_OTEL_DOWNLOAD=1`，验证失败会真实失败（不再 `continue-on-error`）。

## 本地 UI（简易）

```bash
npm run runoff:observability:ui
# 或
npx tsx scripts/ts/dev/pipeline-cli.ts observability ui --port 8765
```

浏览器：最近 traces 列表、单 trace postmortem JSON、experiment eval-report。Trace 详情含 **Resume Planner** 面板（rerun 展开、skipped 默认折叠）。后续可扩展过滤与图表。

## CLI traces

```bash
npx tsx scripts/ts/dev/pipeline-cli.ts traces list --status failed --limit 10
npx tsx scripts/ts/dev/pipeline-cli.ts traces show <traceId>
npx tsx scripts/ts/dev/pipeline-cli.ts traces show <traceId> --json
npx tsx scripts/ts/dev/pipeline-cli.ts traces show <traceId> --postmortem
npx tsx scripts/ts/dev/pipeline-cli.ts traces tail
```

## MCP 用法摘要

**Trace**

```json
{ "status": "failed", "limit": 20, "aggregate": true }
```

```json
{ "traceId": "<id>", "format": "postmortem" }
```

```json
{ "sessionId": "<checkpoint-session>", "detail": true, "format": "full" }
```

**Score**

```json
{ "traceId": "<id>", "name": "helpfulness", "value": 4, "comment": "clear fix" }
```

**Experiment**（需先有多轮 `runoff_run_pipeline`，同 prompt 会共享 `experimentId`）

```json
{ "experimentId": "<id>", "format": "eval-report" }
```

```json
{ "experimentId": "<id>", "format": "dataset" }
```

`variant` 由 hooks 根据 prompt+config 哈希生成；改 config 即新 variant，适合 A/B。

## 扩展原则（后续 UI / 观测）

- UI：在现有 HTTP server 上增加图表、trace↔experiment 深链、实时 tail WebSocket（可选）。
- 严格写盘：`RUNOFF_TRACE_STRICT=1` 时 trace 写入失败会抛错（默认仅 warn）。
- 避免：新配置文件层、重复 trace 存储、托管 SaaS 耦合。
