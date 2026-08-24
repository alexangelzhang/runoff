# runoff 聚焦版竞品矩阵（race 原子）

> 本文是 `differentiation.md` 的收敛版。旧版矩阵（strategic）列出了 6 个差异化 + 宽泛的 tier-1/tier-2 对比，但其中大多数维度（worktree、parallel、config、local trace）已被证明是 **table stakes**，列在矩阵里只会稀释唯一真正有区分度的那一列。
>
> 本文只保留一件事：**same-task race × human judge × learn from picks** 这个原子，围绕它回答"谁有、谁没有、我切哪里"。

---

## 唯一值得打的原子

```
同一任务 → N 个 provider 并行跑（各自隔离 worktree）
         → 暂停，人看两边 diff，挑赢家
         → 系统记住你的选择，下次同类任务自动加权
```

三个环节缺一不可。任何一个环节单独拿出来都不成立：

| 环节 | 单独存在时的问题 |
|------|-----------------|
| same-task race（只比不记） | 一次性脚本，没有复利 |
| human judge（只审不比） | 就是 code review，projd 也有 |
| learn from picks（只记不比） | 就是 Ruflo 的 embedding 漂移，无证据 |

**runoff 是三者唯一同时具备的**（2026-06 已验证，见 `positioning.md`）。

---

## 聚焦矩阵：三个环节 × 主要竞品

| 竞品 | same-task race | human judge + pick | learn from picks | 结论 |
|------|:---:|:---:|:---:|------|
| **runoff** | ✅ | ✅ | ✅ | 唯一三者齐全 |
| Vibe Kanban (26.8k★) | ❌ 不同任务并行 | ❌ 无 pick | ❌ | 快，不是质 |
| projd | ❌ 单 provider 派发 | ✅ 审 PR | ❌ | 有 review，无比 |
| Cadence (v8) | ❌ 不同 phase | ❌ 角色分工 | ❌ | 分角色，不是比 |
| Ruflo | ❌ | ❌ | ⚠️ 相似度漂移（无证据） | 假"自学习" |
| LangGraph / CrewAI / AutoGen | ❌ 通用编排 | ❌ | ❌ | 不同赛道 |

**结论**：矩阵从"6 个差异化"收敛到"1 个原子"后，runoff 的护城河反而**更清晰**了——不是"我们有很多特性"，而是"这件具体的事只有我们做"。

---

## 砍掉哪些噪音维度（旧矩阵里该删的行）

旧 `differentiation.md` 把这些列为主打，但 2026 市场已证明它们是 table stakes。**在新矩阵里全部降级为脚注，不进入对比表。**

| 旧维度 | 为什么删 | 归宿 |
|--------|---------|------|
| Git worktree isolation | Vibe Kanban / projd / Cadence 全有 | 脚注：race 的实现前提，非卖点 |
| Parallel agent execution | 所有 tier-1 都有 | 脚注 |
| Declarative JSON config | projd JSON / Cadence YAML | 脚注 |
| MCP server | 只是分发渠道 | 脚注 |
| Multi-provider (4 CLI) | Cadence 16+ | 脚注 |
| Local trace (no LangSmith) | 合法但非钩子，且是 race 故事的配角 | 脚注 |

---

## 能切的口子（哪里还有差异化空间）

收敛到 race 原子后，剩下的增量空间在**三个深化方向**，而不是横向扩功能：

### 1. race 的"裁决体验"深化
- 现状：人肉看 diff 挑赢家。
- 增量：**结构化 diff 对比视图**（两个候选的 API 决策差异、边界 case 覆盖差异、代码量差异），让"挑"变成 10 秒决策而不是读两个 diff。README 的 demo 已经暗示了这个方向（"string input only" vs "string | Date, future dates"）。

### 2. learn-from-picks 的证据闭环
- 现状：Dream/Dreamify 架构完整，但融合权重硬编码（`positioning.md` 标 P1）。
- 增量：闭合后，"为什么 runoff 在 Go refactor 上更信 Codex"能指向具体 trace 证据。这是对 Ruflo 无证据自学习的直接反杀。

### 3. 竞品无法抄的"本地 + 可审计"
- race + learn 的数据全在 `~/.runoff/`，零 SaaS。企业里"不想把代码偏好数据交给 LangSmith"的团队，这是硬需求。但**它只是 race 故事的配角，不是独立卖点**——单独讲"本地 trace"没人装，讲"race 且数据不上云"才有人装。

---

## 一句话结论

> 别再横向加功能（编排、联邦、自我进化都是噪音）。把 `race → 挑赢家 → 记住口味` 这条链做深、做顺、做出 30 秒 demo，就是 runoff 唯一的赢法。

---

## 相关文档

- `positioning.md` — 市场分析（原子结论的事实来源）
- `focus-plan.md` — 代码层级的留/降/切执行清单
- `differentiation.md` — 旧版宽泛矩阵（收敛前）
- `race-showcase.md` — 6 次真实 race 的 diff 对比（"裁决体验"深化的素材）
