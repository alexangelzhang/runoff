# runoff 产品聚焦方案（focus plan）

> 本文是 `positioning.md` 的执行版。`positioning.md` 完成了**市场分析**并得出结论：
> 唯一未被占据的位置 = **same-task race × human judge × learn from picks**。
> 本文把那个结论落到**代码层级的留/降/切清单**，回答"仓库里 30% 的代码为什么不该出现在产品主路径上"。
>
> 现状证据（2026-08）：全仓库 TS 约 47k 行。

---

## 一句话定位（收敛后，不改）

> **"3 个 AI 竞争写你的代码。你挑赢家。系统记住你的口味。"**

其他所有能力都是实现细节。这句从 `positioning.md` 继承，本文不重写它，只负责**让仓库形态匹配这句话**。

---

## 现状的量化问题：货架远大于货

| 模块 | 行数 | 占比 | 角色 |
|------|------|------|------|
| **race 核心**（`race.ts` + `race-execution.ts` + `race-merge.ts`） | 475 | **1.0%** | 产品主打原子 |
| **Dream/Dreamify**（learn from picks） | 1,538 | 3.3% | 留存钩子 |
| 本地 trace / experiment（observability） | — | ~2% | race 的证据支撑 |
| **harness evolution 控制面**（`harness-*.ts` + `harness-evolve.ts`） | ~8,650 | **18.4%** | 研究向，非生产向 |
| **A2A federation**（`experimental/a2a`） | 5,542 | **11.8%** | 团队协作，冷启动用不上 |
| 其余（编排、治理、workspace、providers…） | ~30k | ~63% | 背景能力（table stakes） |

**结论一句话**：仓库里约 **30%（~14k 行）** 的代码服务于"agent 自我进化"和"多节点联邦"这两个**非主打场景**，而真正的主打原子 `race` 只有 1%。这是"研究野心"和"产品定位"没有对齐的直接证据。

---

## 三层清单：留 / 降 / 切

### ✅ 留（产品核心，一切营销和 demo 从这里出发）

| 模块 | 理由 | 动作 |
|------|------|------|
| **race 核心**（`race.ts` / `race-execution.ts` / `race-merge.ts`） | 唯一未被 tier-1 竞品占据的原子 | 保持并打磨，这是 30 秒 demo 的全部 |
| **Dream/Dreamify** | "learn from picks" 是留存钩子，让 runoff 从一次性脚本变成复利工具 | 保留；P1 补上 `DreamifyRetrievalParams` 融合权重，闭合学习闭环 |
| **本地 trace / experiment** | race 的"可审计记忆"证据支撑，也是"数据不上云"的卖点 | 保留，但只作为 race 故事的配角 |

### 🔻 降（代码保留，从 pitch 里移除，归入 feature doc）

这些是真实能力，但**竞品都有，不是差异化**。`positioning.md` 已列，这里补一句代码层面的含义：**不动代码，只动文档和 demo 叙事**。

| 能力 | 为什么降级 | 归入 |
|------|-----------|------|
| git worktree isolation | Vibe Kanban / projd / Cadence 全有 | `coding-agent-backends.md` |
| declarative JSON DAG | projd 有 JSON、Cadence 有 YAML | `architecture/structure.md` |
| MCP server | 好特性，但只是分发渠道，不是钩子 | getting-started |
| multi-provider 支持 | Cadence 16+，我们 4 个 | technical 对比表 |
| governance / checkpoint / Observation | "生产形控制"是背景能力，不性感 | `governance-config.md` |
| pipeline 编排（非 race） | 又回到"另一个编排框架"的坑 | feature doc |

### ✂️ 切（从主仓库移出或冻结）

**原则**：冷启动期，任何不服务于"race → 挑赢家 → 记住口味"这条 30 秒路径的代码，都是认知负担和仓库噪音。

| 模块 | 行数 | 理由 | 建议动作 |
|------|------|------|---------|
| **harness evolution 控制面**（`harness-*.ts` + `harness-evolve.ts`） | ~8,650 | "agent 自我进化"是论文素材，不是企业买单理由；且 58k 的 tool handler 说明已过度投入 | **切成独立包**（如 `runoff-evolution`）或归档到 `experimental/`，主 README 不提 |
| **A2A federation**（`experimental/a2a`） | 5,542 | 多节点联邦是"团队协作/HA"场景，冷启动期（0→1k★）用不上 | 冻结，README 不提，等有用户要再激活 |

**切的好处（具体到产品）**：
1. `npm i runoff` 的安装体积、类型面、工具面大幅缩小 → 首次体验更快
2. 16 个 MCP 工具里，race 相关的 3 个（`runoff_run_pipeline` + `runoff_race_apply` + `runoff_race_abort`）能浮到最前面，而不是被 `runoff_dream_export` / `runoff_query_memory` 淹没
3. 贡献者 onboarding 时，不用先读懂 harness evolution 的 47 个审计制品类型

---

## 30 天执行顺序（按 ROI 排序，非代码难度）

1. **[文档] README 首段**：换成 `positioning.md` 的一句 bet（当前还是"harness control plane"的旧定位）
2. **[文档] 30 秒 GIF**：prompt → 两个 worktree 跑 → 暂停 → 挑赢家 → 合并（README 已有一个 demo.gif，但需确认它是 race 叙事）
3. **[代码] 切 harness evolution + A2A 出主包**：这是最大的一刀，直接把"货架"砍到和"货"匹配
4. **[代码] P1 Dreamify 融合权重**：闭合 learn-from-picks 闭环（`positioning.md` 已标 P1）
5. **[文档] 竞品矩阵收敛**：见 `race-differentiation-matrix.md`

---

## 成功标准（继承 positioning.md L2）

- 10–20 个工程师每周用 runoff 做 race，会想念它
- "same-task race" 至少在一个博客/HN 帖子里和 runoff 绑定
- 有作者以外的人提 GitHub issue
- **仓库主路径的代码量能对上"race"这个故事**（这是本文独有的验收标准：切完之后，race + Dream 相关代码占比应从 ~4% 提到主路径的绝对主角）

---

## 相关文档

- `positioning.md` — 市场分析与结论（本文的事实来源）
- `race-differentiation-matrix.md` — 聚焦版竞品矩阵
- `differentiation.md` — 旧的宽泛矩阵（收敛前版本，待更新）
