# PRINCE Lessons for runoff — context 与 harness 契约化

Date: 2026-06-25
Status: In progress — P1/P2/P3/P4 runtime contracts started

## 背景

[Building Reliable Agentic AI Systems](https://martinfowler.com/articles/reliable-llm-bayer.html) 介绍了 Bayer / Thoughtworks 的 PRINCE。PRINCE 的技术栈是 Agentic RAG + Text-to-SQL + LangGraph，业务目标是让研究人员查询和复用 preclinical research 数据。

本文不建议 runoff 迁移到 PRINCE 的技术栈。对 runoff 有价值的是两条工程原则：

1. **context engineering**：不同阶段只接收完成职责所需的上下文，不把全部历史、检索结果和工具输出塞进一个 prompt。
2. **harness engineering**：模型外部的执行脚手架负责 orchestration、tool boundary、state persistence、retry、fallback、observability、evaluation、human review。

runoff 已经是 local harness control plane：`pipeline.config.json` 编译为 AgentGraph，Orchestrator 控制执行，Python 层负责 worktree isolation，Observation / trace / control plane 保存运行证据。PRINCE 的价值不是推翻这条路线，而是提示下一步应把已有能力进一步契约化。

## 当前 runoff 基线

| 能力 | runoff 现状 | 设计含义 |
| --- | --- | --- |
| Runtime graph | `pipeline.config.json` → `compileAgentGraphFromPipeline` → Orchestrator / runner | 已有可执行拓扑，不需要引入 LangGraph 作为核心 runtime |
| Recovery | checkpoint / resume、durable run store、file event log、approval / race pause | 已具备 harness 骨架，下一步应细化 step-level 恢复信息 |
| Observability | `PipelineTrace`、`StepTrace`、Observation、postmortem、experiment / eval report | 已有 run-level evidence，缺少 claim-level evidence |
| Evaluation | experiment judge、manual score、held-in / held-out gate、harness evolution reports | 已有评估底座，缺少按 step 类型定义的指标 |
| Context | shared context、pattern cache、Observation artifact refs、context topology artifacts | 已有 context 通道，缺少 step 级输入/输出契约 |

## 设计决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 不迁移技术栈 | 保留 runoff 当前 TS orchestration + Python workspace split | runoff 的差异化是 local-first、MCP、worktree isolation、provider race，不是通用 RAG runtime |
| 先做契约，不先加 agent | 优先定义 context / reflection / evidence / evaluation contract | 新 agent 容易扩大 surface；契约能约束已有 pipeline |
| Reflection 分类 | 区分 process / evidence / draft 三类检查 | 避免所有失败后检查都混成一个 `reflect` |
| Evidence 粒度 | 从 run-level evidence 扩展到 claim-level evidence | final summary、PR comment、MCP response 应能回到 artifact / trace / verification |
| Evaluation 粒度 | 从 end-to-end score 扩展到 stage-level metrics | analyze、implement、review、test、final summary 的好坏标准不同 |

## 不做

- 不接入 LangGraph 作为核心执行器。
- 不接入 Langfuse / LangSmith / CloudWatch 作为默认依赖。
- 不把 runoff 扩展成通用 RAG 平台。
- 不强制所有任务走 `Clarify → Think → Research → Reflect → Write` 固定流程。
- 不在本设计中修改 runtime schema、MCP tool schema 或 `pipeline.config.json`。

## 建议的最小演进

### P1. Step Context Contract

目标：让每个 step 明确“应该看什么、不应该看什么、必须产出什么证据”。

先从文档和 Observation warning 做起，不急于强制 schema。

示例：

```json
{
  "context": {
    "inputs": ["prompt", "repo_diff", "previous_step_observation"],
    "forbidden": ["full_trace_history", "unrelated_artifacts"],
    "requiredEvidence": ["filesModified", "diffStat", "verificationCommand"]
  }
}
```

最小落点：

- `AgentGraphNode` 保持轻量，但文档中定义 context contract 语义。
- Observation 在缺少 `requiredEvidence` 时产生 `coverageGaps`。
- harness evolution 后续可统计哪些 step 经常缺证据。

### P1. Reflection Taxonomy

目标：把 `reflect` 拆成三种可评估检查。

| 类型 | 检查对象 | 典型问题 | runoff 落点 |
| --- | --- | --- | --- |
| process reflection | 执行路径 | step 顺序错、工具选错、retry 方向错 | Orchestrator / reflect re-plan |
| evidence reflection | 证据充分性 | 没有测试输出、artifact 缺失、diff 为空 | Observation `coverageGaps` / artifact validator |
| draft reflection | 输出完整性 | final summary 漏文件、声明无证据、格式不符合 host 需要 | final response / report writer |

当前 `deerflow-reflect` 可以继续作为 process reflection 的窄实现，不要承担所有检查职责。

### P1. Claim-level Evidence

目标：让最终声明能回到具体证据，而不是只给出笼统结论。

建议增加可选结构，不要求所有 caller 立即消费：

```json
{
  "claims": [
    {
      "claim": "Pipeline paused for race judge",
      "evidenceRefs": ["pipeline.observation.status", "traceRef"]
    },
    {
      "claim": "Implementation modified src/foo.ts",
      "evidenceRefs": ["stepResults.implement.observation.evidence", "artifactRefs[0]"]
    }
  ]
}
```

这对应 coding-agent 场景里的 citation：不是引用论文页码，而是引用 trace、artifact、diff、test command、exit code。

### P1. Stage-level Evaluation

目标：不要只评价最终 pipeline 是否 approved，也评价每类 step 是否完成了自己的职责。

| Step 类型 | 建议指标 |
| --- | --- |
| analyze | scope 是否准确、是否识别高风险文件、是否给出可执行测试目标 |
| implement | 是否产生真实 diff、是否限制在 editable surface、是否包含边界处理 |
| review | 是否引用代码证据、误报是否可识别、是否区分 blocker / non-blocker |
| test | 是否记录命令、exit code、关键输出、失败原因 |
| final summary | 每个完成声明是否有 evidence ref，未验证项是否显式列出 |

这些指标应优先进入 eval report / harness evolution，不应先阻塞主链路。

### P2. Clarify as Scope Preflight

PRINCE 的 Clarify User Intent 不应照搬成“每次先问用户”。在 runoff 中，它应表现为 scope preflight：

- work-dir / config 是否明确；
- dirty worktree 是否存在；
- 是否允许文档更新；
- 验证命令是否明确；
- 是否需要 race；
- 是否触发 approval。

高风险或高歧义时返回 `needs_clarification`；低风险时使用 safe defaults 并把假设写入 Observation。

### P2. Step-level Resume Metadata

runoff 已有 checkpoint / resume，但恢复粒度更偏 pipeline session。下一步可以为 step 记录更细的信息：

- step input hash；
- artifact completeness；
- provider result presence；
- workspace attachment state；
- skip / rerun reason。

目标不是实现 LangGraph reducer，而是让 host 能判断“哪些 step 可以安全跳过，哪些必须重跑”。

### P2 runtime 落地

Clarify 已落成 scope preflight，而不是聊天式固定追问：

- `runtime.scopePreflight` 支持配置 `dirtyWorktree` / `docUpdates` / `race` 的 `allow | warn | clarify` 策略。
- `runoff_run_pipeline.scopePreflight` 支持单次调用确认 `allowDirtyWorktree`、`allowDocUpdates`、`allowRace`、`verificationCommand`、`requireVerificationCommand`、`requireCleanWorktree`。
- 高风险或缺少确认时，pipeline 返回 `status: "needs_clarification"`，保存 checkpoint，写 trace，并在 `PipelineObservation.scopePreflight` 中列出 blockers、warnings、assumptions、clarificationQuestions。
- `runoff_query_runs` 把 `needs_clarification` 映射为 `resume_from_checkpoint`，host 需要带同一 `sessionId` 和明确的 `scopePreflight` overrides 继续。

Step-level resume metadata 已落到每个 step：

- `StepResult.resumeMetadata` / `StepObservation.resumeMetadata` / `StepTrace.resumeMetadata` 保存 `inputHash`、`artifactCompleteness`、`providerResultPresent`、`workspaceAttachment`、`canSkipOnResume`、`mustRerunReason`、`rerunReason`。
- `inputHash` 基于 structured prompt、rendered prompt、provider/routing、round、workDir、retry signal 生成。
- `artifactCompleteness` 使用 `contextContract.requiredEvidence` 判断 `complete | partial | missing`。
- checkpoint 保存这些 step results，因此 crash/retry 后 host 能判断 step 是否可跳过或必须重跑。

### P3 runtime 落地

Resume planner 已开始消费 step-level resume metadata，而不再只把它展示给 host：

- `runPipelineDAGLoop` 启动时读取 checkpoint 中同一 round 的已完成 step。
- 旧 checkpoint 或旧 step result 没有 `resumeMetadata` 时保持兼容：沿用 pre-P3 行为，把成功 step 视为可跳过。
- 若 `resumeMetadata.canSkipOnResume=false`，runner 会把该 step 标回 `queued` 并在同一 round 重跑。
- 若上游 step 必须重跑，runner 会递归 invalidation 它的下游已完成 step，避免 review/test/final summary 继续复用 stale upstream output。
- 被标回待执行的 step 会保留 provider/model/kind/contextContract 等轻量上下文，并把 rerun 原因写回 `resumeMetadata.rerunReason` / `mustRerunReason`。
- runner 会基于仍可复用的 completed step 重新构建 candidate；如果没有可复用 candidate，则回到空 candidate，从需要重跑的最早 step 重新生成。

### P4 runtime 落地

Resume planner 的决策已从 logger 提升为结构化 runtime evidence：

- `ResumeReusePlanReport` 记录同一 round resume 时每个可复用/需重跑 step 的 `decision`、`reason`、`downstreamOf` 和 `evidenceRefs`。
- `PipelineResult.resumeReusePlan` / `PipelineObservation.resumeReusePlan` / `PipelineTrace.resumeReusePlan` 暴露 planner 结果，host 不需要 scrape log。
- `PipelineState.resumeReusePlan` 把 planner 结果写入 checkpoint，后续 resume / pause / query 可以看到本轮恢复决策。
- `PipelineObservation.evidence` 增加 `resumeReusePlan=rerun:N,skipped:M`，`coverageGaps` / `typedCoverageGaps` 对 rerun step 产生 process reflection。
- P4 仍是 observability，不是 hard gate；缺少旧 checkpoint metadata 时仍保持 P3 的兼容降级。

## 验证标准

本设计进入实现前，至少满足：

1. **无 runtime 迁移**：不引入 LangGraph / SaaS observability 作为默认依赖。
2. **无 schema 大爆炸**：context / evidence / reflection 字段先做 optional，旧 config 继续可用。
3. **可观测**：新增 contract 的缺口必须出现在 Observation、trace 或 eval report 中，不能只写日志。
4. **可评估**：每个新检查都能说明对应 step 类型和失败例子。
5. **可降级**：缺少 contract 时 pipeline 仍运行，但报告 coverage gap。

## 已开始

- `StepResult.contextContract` / `StepObservation.contextContract`：记录 step 期望输入、禁止输入和所需证据。
- `typedCoverageGaps`：把 coverage gap 初步分成 `process` / `evidence` / `draft`。
- `claims[].evidenceRefs`：把 step / pipeline summary 绑定到 artifact refs、trace refs 或结构化 evidence。
- `PipelineObservation.stageEvaluations`：按 step 名生成 analyze / implement / review / test / final_summary 的 metric hints。
- `ExperimentEvalReport.stageEvaluationSummary`：从 trace 的 `PipelineObservation.stageEvaluations` 聚合 stage kind、metric name、evidence ref，并统计缺 trace / 缺 stage hints 的 run 数。
- `StepContextContract.requiredEvidence`：成功 step 缺少所需证据时写入 `coverageGaps` / `typedCoverageGaps`，不改变 step status。
- `formatPipelineRunOutcomeHints`：CLI final summary hints 输出 `claims[].evidenceRefs`，供人工摘要或后续 PR comment adapter 复用。
- `PipelineResult.scopePreflight` / `PipelineObservation.scopePreflight`：运行前 scope preflight 的结构化报告；需要澄清时返回 `needs_clarification`。
- `StepResult.resumeMetadata` / `StepObservation.resumeMetadata` / `StepTrace.resumeMetadata`：step input hash、artifact completeness、provider result presence、workspace attachment、skip/rerun 判定。
- `applyResumeStepReusePlan`：恢复同一 round 时消费 `canSkipOnResume`，对不可跳过 step 及其下游做 runtime rerun planning。
- `PipelineResult.resumeReusePlan` / `PipelineObservation.resumeReusePlan` / `PipelineTrace.resumeReusePlan` / `PipelineState.resumeReusePlan`：结构化暴露 runner 已执行的 resume reuse plan，包括 rerun/skipped summary、downstream invalidation 和 evidence refs。

这些字段都是 optional 或向后兼容字段；旧 config 和旧 observation consumer 仍可只读取原有 `coverageGaps`、`artifactRefs`、`stepRefs`。

## 当前 schema 决策

暂不扩展 `AgentGraphNode` 或 `pipeline.config.json`。

理由：

- P1 字段仍是 observation/report 级 hint，当前目标是暴露缺口，不是阻塞 pipeline。
- 现有配置不需要声明 context contract，也能得到默认 contract 和 warning。
- 先让 eval-report、CLI hints 和 host consumer 跑几轮，再把稳定字段上升为显式 schema，避免把早期 taxonomy 固化进 config。

重新评估条件：

- eval-report 或 host summary 开始依赖某个 required evidence profile；
- 多个 pipeline 需要覆盖默认 context contract；
- harness evolution gate 需要按 stage kind 做强制判定。

## 推荐下一步

1. 用真实 pipeline trace 检查 `stageEvaluationSummary` 的缺口统计是否有用。
2. 根据真实缺口调整 default `requiredEvidence`，不要先加硬 gate。
3. 若要做 PR comment adapter，直接消费 `PipelineResult.observation.claims[].evidenceRefs` 和 CLI hints 中的 claim evidence refs。
4. 用一次真实 dirty worktree / docs update run 校准 `runtime.scopePreflight` 的默认策略是否过严。
5. 用真实 resumed pipeline trace 校准 `resumeReusePlan` 的 host 展示方式，尤其是不可跳过 step 的 `mustRerunReason` 和 downstream invalidation 原因。

## 参考

- Martin Fowler / Thoughtworks: [Building Reliable Agentic AI Systems](https://martinfowler.com/articles/reliable-llm-bayer.html)
- Frontiers in Artificial Intelligence: [From data silos to insights: the PRINCE multi-agent knowledge engine for preclinical drug development](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2025.1636809/full)
- runoff: `docs/features/observability.md`
- runoff: `docs/reference/industry-benchmark.md`
- runoff: `src/orchestration/agent-graph.ts`
- runoff: `src/orchestration/observation.ts`
- runoff: `docs/features/deerflow-reflect.md`
