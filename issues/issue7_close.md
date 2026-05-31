# Phase 7 Review — 剩余地基未固化清单

> **Status: CLOSED**（2026-05-27 审查）。无开放项。

Date: 2026-03-29
Scope: 基于 `issue6_close.md` 修复后的二次验收，聚焦仍会阻塞 Multi-Agent Orchestration 的基础问题
Status: **All 8 items resolved.** Gate 1 Foundation 验收通过。

---

## P0 — 仍然阻塞主链的硬问题

| # | 问题 | 状态 | 说明 |
|---|------|------|------|
| 7.1 | Workspace create / destroy 路径契约冲突 | **FIXED** | `_validate_worktree_path` 已允许 `managed_workspaces_dir()`，lifecycle test 通过 |
| 7.2 | watcher / task_runner / tests result contract 不统一 | **FIXED** | task_runner 返回统一 `TaskResult`，3 个 watcher smoke test 全绿 |
| 7.3 | watcher 仍是薄壳分发器 | **Phase 0 OK** | 薄分发器是 Phase 0 正确设计，agent runtime orchestration 是 Wave 7.x |
| 7.4 | task_runner one-shot executor | **FIXED** | delegateArgv 打通，workspace metadata 返回，result 协议稳定 |
| 7.5 | 锁语义 correctness 未验证 | **FIXED** | exclusive 互斥 ✔，shared 共存 ✔，backoff ✔，concurrency + resilience 测试全绿 |
| 7.6 | race finalize 断链 | **FIXED** | `RaceCandidateSnapshot` 存 workspace 元数据，apply/abort 重建 workspace |
| 7.7 | config schema 不够稳定 | **Phase 0 OK** | 当前 tuple DSL 稳定，agent orchestration schema 是 Wave 7.5 |
| 7.8 | orchestration runtime 缺 durable control plane | **Phase 0 OK** | DAG loop + checkpoint 是 Phase 0 正确形态，durable 是 Wave 7.2 |

---

## Gate 1 验收结果（2026-03-29）

| # | 检查项 | 结果 |
|---|--------|------|
| G1.1 | `tsc --noEmit` | ✅ 零错误 |
| G1.2 | `npm test` | ✅ 160 pass, 0 fail, 3 skip |
| G1.3 | Workspace 生命周期 | ✅ create → commit → collect → apply → destroy 全链路通过 |
| G1.4 | IPC 合约一致性 | ✅ `check-ipc-sync` OK (payload v6, result v5, 18/17 fields) |
| G1.5 | Lock 语义 | ✅ exclusive 互斥 + shared 共存 + backoff，concurrency + resilience 测试全绿 |
| G1.6 | Race finalize | ✅ 3 provider 竞速 → apply winner → abort losers，smoke test 通过 |
| G1.7 | Config 校验 | ✅ 畸形 config 报错明确，不 crash |

**结论：Gate 1 Foundation 验收通过。Phase 0 地基已固化，可以进入 Wave 7.x 开发。**
