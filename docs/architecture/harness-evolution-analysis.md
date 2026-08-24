# Harness Evolution 深度分析

> ⚠️ **历史文档**：本文分析的 `src/experimental/harness-evolution/` 已拆分到独立的 `agent-evolution` 工程（见 `harness-evolution-extraction.md`）。分析结论仍适用于该工程的架构，但代码路径已不在本仓库。
>
> 将原 `src/experimental/harness-evolution/` 的实现放进 Lilian Weng《Harness Engineering for Self-Improvement》与 6 篇 harness 演化论文的坐标系里，逐条对照其定位、优势与缺口。

## 参考来源

- Lilian Weng, *Harness Engineering for Self-Improvement*, Lil'Log (Jul 2026). https://lilianweng.github.io/posts/2026-07-04-harness/
- ACE — *Agentic Context Engineering* (Zhang et al. 2025). https://arxiv.org/abs/2510.04618
- *Harness Updating Is Not Harness Benefit* (Lin et al. 2026). https://arxiv.org/abs/2605.30621
- MCE — *Meta Context Engineering via Agentic Skill Evolution* (Ye et al. 2026). https://arxiv.org/abs/2601.21557
- *Meta-Harness: End-to-End Optimization of Model Harnesses* (Lee et al. 2026). https://arxiv.org/abs/2603.28052
- *Self-Harness: Harnesses That Improve Themselves* (Zhang et al. 2026). https://arxiv.org/abs/2606.09498
- AHE — *Agentic Harness Engineering: Observability-Driven Automatic Evolution* (Lin et al. 2026). https://arxiv.org/abs/2604.25850

## 一句话结论

> **runoff 的 `harness-evolution` 是一个"审计优先、宿主在环"的 Self-Harness/AHE 变体**——它完整吸收了 `propose → evaluate → accept` 循环、`held-in/held-out` 分割、`editable surface` 约束和 frontier 概念，但刻意放弃了 population 级进化、完全自主的 meta-level 搜索和自动 merge。它的独特价值主张不是"搜得更快"，而是把 Lilian Weng 的 challenge #5（reward hacking）与 AHE 的"收益必须可归因"做成了第一等公民。

---

## 一、定位：在"优化对象演进轴"上处于哪一级

Lilian Weng 给出的演进轴：

> instruction prompts → structured context → workflow → **harness code** → optimizer code

runoff 的 `harness-evolution` 落点是 **harness code / harness config** 级，而非 context 或 workflow 级——它进化的对象是 candidate `variant/` 目录里的**文件**（受 `editableSurface` 约束），并用 gate / frontier / promotion 这些"程序搜索"语言描述结果。这把它和 ACE/MCE（context 级）明确区分开，与 Meta-Harness、Self-Harness、AHE、AlphaEvolve、DGM 同属"harness code 可执行搜索"一族。

但它**没有**走到最后一级（optimizer code）——它的 meta 层是**宿主（host agent）通过 MCP 工具显式编排** `runHarnessEvolution`，而不是像 MCE / Meta-Harness 那样让一个 meta-agent 自主搜索"如何优化"的机制本身。

---

## 二、逐篇对照

### 1. Self-Harness（2606.09498）—— 结构上最像，几乎是同构

| Self-Harness 阶段 | runoff 对应实现 |
|---|---|
| Weakness Mining：聚类失败 → verifier-grounded failure patterns | `mineHarnessFailureSignatures()`（`harness-candidate.ts`）按 `failureCategory` + `signatureKey` 聚类 trace，按 severity / traceCount 排序 |
| Harness Proposal：bounded edits（editable surface + failure patterns + passing behaviors + 之前尝试的摘要） | `proposeHarnessCandidate()`：provider 在 `variant/` 目录改文件，`editableSurface` 约束；`buildProposalPrompt` 注入 failure signatures + `history-context.json`（prior candidates + rejected buffer） |
| Proposal Validation：held-in 解弱点 / held-out 查回归，无回归才接受，rejected 只 log | `gate.heldIn` / `gate.heldOut` 的 improvements / regressions；`decideHarnessSkillPatch` 要求 `regressionPassed`；`recordHarnessRejectedBuffer` 落盘 reject、不改 active harness |

**关键差异**：Self-Harness 接受后 **merge 更新 active harness**（`h_t → h_{t+1}`）；runoff 的 accept 只产生 `accepted` 状态 + **promotion bundle 导出**。`exportHarnessPromotionBundle` 明确声明 *"runoff did not mutate the source repository"*，bundle 指令是 *"Review this promotion bundle before applying anything to a user repository"*——把自动 merge 换成了人工 review 的导出包。

### 2. AHE（2604.25850）—— observability 三支柱的工程化落地，但闭环更弱

- **Component observability**（每个 editable component 有 file-level 表示）→ `operating-layer` rule registry（`coding_standard` / `qa_plan` / `review_rubric` / `lint_guidance` / `architecture_boundary`…）+ `editableSurface` + `normalizeSurfacePath`。**对齐良好。**
- **Experience observability**（分层 drill-down evidence corpus）→ `buildHarnessHistoryContext` 生成 `history-context.json`：failure signatures + 最近 5 个 prior candidates + rejected buffer 摘要。**对齐，但分层更浅**（见缺口 2）。
- **Decision observability**（每个 edit 配 falsifiable prediction，下一轮验证）→ `expectedFixes` / `possibleRegressions` 字段 + `proposeHarnessCandidate` 的 **reported-vs-observed diff 比对**（`unreportedFilesModified` / `reportedButUnchangedFiles`，在 `auditHarnessCandidate` 里是 blocker 级 finding）。**忠实移植。**

但 AHE 最尖锐的一条——*"every edit is a file-level, falsifiable claim and can be verified in the next round"* 的**逐条 falsification 闭环**，runoff 只做到一半：有 prediction 字段和结果层验证（`selectionDelta = improvements − regressions`），但没有把"这一轮声称的 `expectedFixes` 是否在下轮逐条兑现"作为独立 gate 回写。

### 3. Lin et al. 2026（2605.30621）—— 最有杀伤力的一个洞见

核心发现：

- **harness-updating**（产出有用 harness 编辑的能力）在 base capability 上是 **flat** 的：Qwen3.5-9B 的编辑增益 ≈ Claude Opus 4.6。
- **harness-benefit**（利用 harness 的能力）**非单调**：mid-tier 模型受益最大，weak / strong 两端都低。

对 runoff 的直接含义：

1. **proposer 用谁，不该和"执行器用谁"混在一起。** `runHarnessEvolution` 里 `input.provider` 同时驱动 proposal 与下游评估，但代码层面**没有 harness-benefit 的独立测量**——它隐含假设"更强的 provider = 更好的演化器"，而这篇论文证伪了这个假设。
2. `heuristicFitness`（keyword-overlap + length penalty，零 API 调用）本质上是**弱模型也能跑的廉价代理**——这与"updating 能力 flat"一致（cheap proposer 够用），但也意味着这个 fitness 信号很浅，容易被 reward-hack。

### 4. Meta-Harness（2603.28052）—— 概念同源，但 feedback 通路被压缩

同属"harness code 可执行搜索"，runoff 有 `updateHarnessFrontier` / `HarnessFrontier`（对应 Pareto frontier）。但 Meta-Harness 的核心教训是 **"rich access to prior experience"**：proposer 直接通过 filesystem 读所有 prior candidates 的**源码 + scores + 完整 execution traces**，而它批评的传统 text optimizer "compress feedback too aggressively"。

runoff 恰好落在这个被批评的侧：`buildHarnessHistoryContext` 给 proposer 的是**结构化摘要**——prior candidates 只取前 5 条的 `status / summary / decision / observedFilesModified`，failure signatures 是聚类后的签名，不吐原始 trace。token-efficient 是对的（AHE 的 layered access 思路），但它**没有"需要时钻回 raw trace"的下钻通道**。

### 5. ACE / MCE（2510.04618 / 2601.21557）—— context 级，runoff 只沾了边

- **ACE** 的 generator / reflector / curator 三分、结构化 itemized 更新防 `context collapse` / `brevity bias`——runoff 的 `compileHarnessFeedback` + rule registry 在精神上接近（结构化、可 dedup），但 ACE 的 reflector / curator 是**自动**的，runoff 是宿主显式调用。
- **MCE** 的 bi-level 优化（meta-level `agentic crossover` 搜索 skill 历史 + base-level 执行 skill 学 context）——runoff 的 operating-layer 有 `createHarnessContextTopology` / `routeHarnessContext`（对应 base-level 的"context 作为文件+代码"），但**完全没有 meta-level crossover**：它没有一个 agent 自主地"对历史 skill 做交叉重组"。

合起来看：**runoff 有意地把"自主 meta 搜索"外包给了宿主**（`run` + `report`，报告必须暴露 `nextAction`），而不是内置自主 meta-agent。这是一个架构选择，不是遗漏。

### 6. 进化搜索一族（AlphaEvolve / DGM / ShinkaEvolve）—— runoff 缺了种群

`evolveHarnessCandidate` 有迭代 + `buildReflectionInstructions`（上一轮 feedback 喂给下一轮）+ `heuristicFitness`，是典型进化式；但它是**单链 lineage**（`parentCandidateIds` 链），不是 pool + 选择压力 + 分支：

- 没有 population，就没有 fitness 相对排名下的**选择压力**（`rankHarnessCandidates` 只是给单个 candidate 打分排名，不是从种群里选父代）。
- 没有 ShinkaEvolve 的 **novelty rejection sampling**（embedding 相似度拒绝近亲）——直接对应 Lilian Weng challenge #4（diversity collapse）。runoff 的 rejected buffer 有 `similarityKeys`，但那是**给 proposer 看的提示**，不是**拒绝机制**。

---

## 三、做得对的地方（论文洞见工程化得比论文更保守）

1. **reward-hacking 防线最厚。** 对照 Lilian Weng challenge #5 和 AHE 的防 hack 约束（*"runs / tracer / verifier / LLM config 只读，禁用 verifier、换模型、拉高 reasoning budget"*），runoff 落地了：
   - proposer 只能在 `variant/` 隔离目录内改（`workDir` 注入），
   - `editableSurface` 越界是 blocker，
   - **reported-vs-observed diff 比对**（防"声称改了其实没改"的作弊），
   - **leakage-term 扫描**（`auditHarnessCandidate` 把 dataset 的 `leakageTerms` + held-out 的 `baselineTraceId` / `failureSignatureIds` 扫进 variant 文本，命中即 blocker）——对治"把 held-out 答案硬编码进 harness"的过拟合，
   - accept 需要 **held-in/held-out 双无回归** + role policy + audit 全过。

   这套比 Self-Harness 的"无回归即 merge"更严，贴合论文共识（*"evaluator 和 permission control 应放在 loop 外"*）。

2. **收益可归因。** AHE 的核心主张"让每个 gain 都能归因到 harness edit 而不是换模型 / 关验证器"，runoff 用"provider 只读、verifier 不在 editable surface、promotion 只导出"实现了。

3. **诚实性约束。** AGENTS.md 明确 *"training exports must not fabricate token-level logprobs / loss masks / trainer-only telemetry"*——对应 reward hacking / 数值 duct tape 问题，拒绝伪造训练信号。

4. **rejected buffer 是论文共识的正确落地。** 对应 Lilian Weng challenge #3（negative results 应易保存）和 Self-Harness 的"rejected 只 log 不改 harness"。

---

## 四、缺口（用论文洞见点出的可改进项）

按严重度排序：

1. **没有 harness-benefit 测量，proposer / evaluator 能力错配风险**（Lin et al. 2026）。runoff 假设强 provider 当好 proposer，但论文说 updating 能力 flat、benefit 才是非单调瓶颈。**方向**：给 evaluation 层加"同一 harness 在不同执行模型上的 gain"对比视图，把能力预算引导到 task-solving agent 而非 evolver。

2. **feedback 通路被过度压缩**（Meta-Harness 批评点）。`history-context.json` 是摘要式，proposer 无法下钻 raw trace。**方向**：保留摘要作为默认，加"按需读原始轨迹"的引用（类似 AHE 的 layered drill-down）。

3. **decision observability 闭环不完整**（AHE）。有 `expectedFixes` / `possibleRegressions` 字段但没有逐条 falsification 回写。**方向**：下一轮评估时把上一轮的 prediction 逐条标记 `hit / miss`，让 prediction 真正成为 falsifiable contract。

4. **无 population / 无 novelty 机制**（Lilian Weng #4，ShinkaEvolve）。单链 lineage 会坍缩。**方向**：在 proposer 前用 `similarityKeys` 做**拒绝近亲**（rejected buffer 已有 key，差一个拒绝动作）。

5. **fitness 代理太浅**（`heuristicFitness` keyword-overlap）。它是 Hermes-ASE 式 proxy，弱模型可跑但易被 hack。已有 `llmJudgeFitness` 作为慢评，但缺"objective gate 为主、proxy 只做 early-stop"的明确分层声明。

---

## 五、总结判断

> **一个故意"半自动"的 harness 进化控制平面。** 它把论文里最贵的两样东西——**自主 meta 搜索**（MCE / Meta-Harness 的 meta-agent）和**自动 merge**（Self-Harness 的 `h_t → h_{t+1}`）——都换成了**宿主显式编排 + 人工 decision touch point + promotion 只导出**。

这不是能力不足，而是**有意的保守定位**（AGENTS.md 反复强调：experimental、not on the main product path、control-plane contracts、不自动改用户仓库）。在这个定位下，它**超额完成**了论文最强调的安全侧（reward hacking 防线、可归因、held-out 无回归、失败可保存），但在**"搜得更快更全"那一侧**（population、novelty、feedback 下钻、harness-benefit 测量、falsifiable prediction 闭环）有明显欠账。

**最该采纳的一条论文建议**：采纳 Lin et al. 2026 —— 把能力预算从 evolver 挪到 task-solving agent 的 harness 调用能力，并给 runoff 补一个 harness-benefit 的测量维度。因为 runoff 目前的结构已经假设"演化器越强越好"，而这正是那篇论文用实验证伪的假设。

---

## 六、缺口落地记录

上文列出的 5 条核心缺口已在 `src/experimental/harness-evolution/` 落地：

| 缺口 | 落地实现 | 关键符号 |
|---|---|---|
| #1 harness-benefit 测量 | 按 executor model 分组 baseline→candidate 增益，单模型样本时显式声明"不可评估单调性" | `measureHarnessBenefit`（`harness-evaluation.ts`）→ `HarnessBenefitReport` |
| #2 feedback 下钻 | history-context 增加 `rawTraceRefs`（traceId + tracePath + finalStatus），proposer 可按需读原始轨迹 | `buildHarnessHistoryContext`（`harness-candidate.ts`） |
| #3 decision falsification | 每条 `expectedFixes` / `possibleRegressions` 对照 gate evidence 打 `hit/miss/confirmed_risk/clear` | `evaluateHarnessPredictions`（`harness-evaluation.ts`）→ `HarnessPredictionVerdict` |
| #4 novelty 拒绝 | 提案前用 rejected buffer 的 `similarityKeys` 做近亲拒绝，命中即短路（不浪费 provider 调用） | `checkHarnessNovelty` + `proposeHarnessCandidate` short-circuit |
| #5 fitness 分层 | `heuristicFitness` 显式标注 `proxy_quick_fitness`，迭代记录 `fitnessKind` 声明"proxy 仅 early-stop，accept 由 objective gate 决定" | `HarnessIterationRecord.fitnessKind` |

两者均通过 `runHarnessEvolution` 自动产出并写入 `HarnessEvolutionRun` / `HarnessEvolutionReport`，同时暴露为 MCP `runoff_harness_evolve` 的 `action=predictions` / `action=benefit`。审计工件新增 `prediction-verdict.json` 与 `benefit-report.json`（路径契约在 `harness-artifact-store.ts`）。
