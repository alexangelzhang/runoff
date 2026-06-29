# runoff vs Hermes Agent Self-Evolution

> 对标 [NousResearch/hermes-agent-self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution)（DSPy + GEPA 进化式 skill 优化）。记录我们借鉴了什么、为什么、以及两者的定位差异。

## 一句话定位

- **Hermes-ASE 是优化器引擎**：给定一个 artifact（skill / prompt / tool 描述），用 GEPA 反思式进化把它改得更好。
- **runoff 是控制平面**：记录、隔离、评估、审计 artifact 演化的全过程（datasets / verifiers / rewards / candidates / acceptance / rollback / promotion）。

两者互补：把 GEPA 的"如何改进"接进 runoff 的"如何记录与门控"，就是一个完整的 self-evolution 系统。

## Hermes-ASE 实际形态（基于源码，非 README）

核心实现约 1800 行，`tools/` `prompts/` `code/` `monitor/` 四个目录是空 `__init__.py`——README 的 5 个 Phase 只有 **Phase 1（skill 演化）真正落地**。

落地的那条窄路径：

```
SKILL.md 正文 → 当成 DSPy 可优化参数
  → LLM 生成评测数据集（synthetic / golden / sessiondb 挖掘）
  → dspy.GEPA 反思式变异（读 trace 理解为何失败，定向改进）
  → 约束门（size / growth / structure / 可选 pytest）
  → holdout 集对比打分
  → 产出 PR 给人类审
```

关键设计：
- **GEPA 纯文本进化，不训权重**，全程 API 调用，$2-10/run，零 GPU。
- **双层 fitness**：循环内用廉价 keyword-overlap 代理打分，仅在选择性场合用 LLM-as-judge（多维 rubric + 长度惩罚）。
- **操作 ON 目标仓库，不在其内部**：读目标、写 git 分支、发 PR。

## 我们借鉴的三点

### 1. GEPA-style 迭代进化 proposer

runoff 原本的 `proposeHarnessCandidate` 只做**单次** let-provider-edit-then-diff。借鉴 GEPA 的 reflect-and-improve 循环，新增 `evolveHarnessCandidate()`：每轮产出独立 candidate 变体，用廉价本地 fitness 打分，把上一轮的 diff + score + feedback 注入下一轮 prompt 做反思，最后选最高分轮次。

- 不 import DSPy（Python 侧）；复用 runoff 已有的 provider、variant 隔离、editable-surface 契约，全 TS 实现。
- 每轮独立 candidateId（`{base}-iter-{N}`）+ `parentCandidateIds` 链接，保留完整审计链与 lineage。
- 要接真正的 GEPA 优化器：把它暴露成 cli/MCP provider，作为 `provider` 传入即可（走现有 paddock adapter 思路）。

实现：`src/orchestration/harness-evolution.ts` 的 `evolveHarnessCandidate`。
接入：MCP `runoff_harness_evolve` action=`evolve`；CLI `pipeline harness evolve`。

### 2. 双层 fitness：快代理 → 选择性 LLM-judge

借鉴 Hermes-ASE 的省钱技巧——优化循环内用廉价启发式过滤，只在 final / top-N 比较时用 LLM judge。

- `heuristicFitness()`：纯本地、0 API 调用。score = 0.3 基础 + 0.3×(expectedFixes 关键词命中率) + 0.2×(约束通过) + 0.2×(1-长度惩罚)。用于迭代循环每轮打分。
- `llmJudgeFitness()`：LLM-as-judge 多维打分（correctness / procedure / conciseness，按 rubric 加权，含长度惩罚）。贵，仅用于 final/top-N。
- reward kind 扩展：新增 `heuristic_overlap`（廉价代理）和 `llm_judge` 两类。

实现：`src/orchestration/harness-evolution.ts` 的 `heuristicFitness` / `llmJudgeFitness` / `rewardForResult`。

### 3. Gate ≠ Fitness：分级门控流水线

借鉴 PLAN.md 的原则 **"Benchmarks are GATES, not fitness functions"**——fitness 衡量"artifact 本职做得更好了吗"，gate 只负责"有没有搞坏别的"。

`runHarnessEvolution` 在 proposal 完成后按 order 执行分级 gate stages，结果记录在 `HarnessEvolutionRun.gateResults`：

| order | stage | kind | required | 复用 |
|------|-------|------|----------|------|
| 1 | constraints | constraint | ✅ | proposal 越界检测 |
| 2 | quick_fitness | quick_fitness | — | `heuristicFitness`（只打分不 reject） |
| 3 | dataset_gate | fitness | ✅ | `evaluateHarnessDataset` |
| 4 | audit | coherence | ✅ | `auditHarnessCandidate` |

实现：`src/orchestration/harness-evolution.ts` 的 `DEFAULT_GATE_STAGES` + `runHarnessEvolution`。

## 诚实的边界（不该照搬）

- **Hermes-ASE 范围窄得多**：只演化 hermes-agent 自己的 skill/prompt。runoff 是通用控制平面，整体当模板会让 runoff 收窄。
- **绑死 hermes-agent 基础设施**（batch_runner / SessionDB / TBLite）。可移植的是算法和数据流，不是代码。
- **semantic preservation 等 guardrail 在 Hermes-ASE 代码里是空的**——README 写得全，实现远未跟上。评估成熟度以代码为准：Phase 1 之外都是计划。
- **跨 run 学习** runoff 更强（Dream/Dreamify + trajectory/reward 账本）；Hermes-ASE 的 Phase 5 continuous loop 尚未实现。

## 未来合作点

把真正的 DSPy/GEPA 优化器作为 Python 进程，通过 runoff 的 cli/MCP provider + paddock adapter 接入，让 `evolveHarnessCandidate` 的每轮 propose 由 GEPA 驱动，runoff 继续负责隔离、评估、门控与审计。
