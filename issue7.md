# Phase 7 Review — 剩余地基未固化清单

Date: 2026-03-29
Scope: 基于 `issue6.md` 修复后的二次验收，聚焦仍会阻塞 Multi-Agent Orchestration 的基础问题

---

## P0 — 仍然阻塞主链的硬问题

| # | 问题 | 文件 | 说明 |
|---|------|------|------|
| 7.1 | Workspace create / destroy 路径契约仍然冲突 | `src/workspace.ts`, `scripts/workspace_manager.py`, `tests/workspace.test.ts`, `tests/orchestration.smoke.test.ts` | worktree 被创建在 `$LLM_PIPELINE_HOME/workspaces/...`，但 `do_destroy()` 又强校验 worktree 必须位于 repo 内部，导致 destroy 大量失败，session workspace / race cleanup / smoke test 都不稳定。 |
| 7.2 | watcher / task_runner / smoke tests 的 result contract 还没统一 | `scripts/task_runner.py`, `scripts/watcher.sh`, `tests/watcher.smoke.test.ts`, `tests/orchestration.smoke.test.ts` | 运行时现在返回 `status: "success"`、`content/summary`，而 smoke tests 仍期待 `status: "done"`、`output`、`sessionWorkspace`、`Isolated worktree:` 等旧字段，说明单一运行时契约还没收口。 |
| 7.3 | watcher 仍是薄壳分发器，不是 agent runtime orchestrator | `scripts/watcher.sh`, `scripts/task_runner.py`, `src/providers/cli.ts` | watcher 现在只做 task claim + 启动 `task_runner.py`，没有 worktree/session orchestration、没有 provider-specific agent 语义、没有 diff/finalize 控制，和 Multi-Agent agent runtime 目标还有明显断层。 |
| 7.4 | task_runner 仍然是简化 one-shot executor，真实 agent 主执行链还没打牢 | `scripts/task_runner.py`, `src/providers/cli.ts`, `tests/watcher.smoke.test.ts` | 虽然 `delegateArgv` 已打通，但 runner 仍缺 session workspace reuse、稳定的 stdout/result 协议、provider runtime hook、agent-write finalize 语义，当前更像测试执行器而非 production agent runner。 |
| 7.5 | 锁语义虽然改了，但 correctness 还没有被验证收敛 | `scripts/workspace_manager.py`, `src/workspace.ts`, `tests/concurrency_lock.test.ts`, `tests/resilience_lock.test.ts` | 默认独占 / 显式共享的语义已尝试实现，但锁相关测试仍失败，说明实现、测试或两者至少一边还有问题；在并发 agent 场景下这块仍不可信。 |
| 7.6 | race finalize 主链没有接上真实 workspace ownership | `src/scheduler.ts`, `src/race-registry.ts`, `src/tools/race.ts`, `tests/orchestration.smoke.test.ts` | scheduler 注册 race session 时只记录 patch/diff 元数据，没有把 `workspace` 实例接入 registry；而 `llm_race_apply` / `abort` 又依赖 candidate.workspace 去 apply / destroy，导致 race finalize 逻辑仍是断链状态。 |
| 7.7 | config 主契约虽收口到 tuple DSL，但还不是未来 agent orchestration 的稳定 schema | `src/config.ts`, `src/tools/show-config.ts`, `pipeline.config.json` | issue6 级别的问题虽然缓解了，但当前 config 仍只覆盖 DAG tuple pipeline，还没有为 agent graph / orchestration / policy / artifact contract 预留稳定结构，后续 Wave 7 容易再次大改主链。 |
| 7.8 | orchestration runtime 仍是 DAG loop，durable run/approval/replay 地基尚未建立 | `src/tools/run-pipeline.ts`, `src/orchestration/pipeline-runner.ts`, `src/trace.ts`, `src/state.ts` | 当前主流程仍然围绕 round-based DAG loop、checkpoint 和 review gate 运行；没有 durable run store、event log、approval suspension、replay basis，距离 production-grade multi-agent runtime 还差一层真正的 control plane。 |

---

## 当前验证结论

- `npm run build` 已通过，说明类型/编译主链比之前稳定。
- 但 `npm test` 仍未全绿，失败集中在：
  - `tests/workspace.test.ts`
  - `tests/watcher.smoke.test.ts`
  - `tests/orchestration.smoke.test.ts`
  - `tests/concurrency_lock.test.ts`
  - `tests/resilience_lock.test.ts`
- 因此，当前状态不能定义为“地基已经修完”，更准确的判断是：**issue6 的主线修复已推进，但 runtime foundation 仍未验收通过。**

---

## 建议的明日修复顺序

1. 先修 `7.1 Workspace create/destroy`，把 worktree lifecycle 完整打通。
2. 再修 `7.2 watcher/task_runner/tests` 契约统一，明确唯一 result schema。
3. 修 `7.6 race workspace ownership`，把 race finalize 主链接通。
4. 修 `7.5 lock correctness`，把独占/共享锁测试打绿。
5. 最后收口 `7.3 + 7.4 + 7.8`，把 watcher/runner/runtime 的职责边界重新钉牢。
