# Issues 未关闭项汇总

> Index: [issues/README.md](README.md) · **2026-05-31**：新增 1 项开放记录（CLI 环境，后续修复）。

## 开放项

| 文件 | 主题 | 优先级 |
|------|------|--------|
| [open/real-provider-smoke-cli-2026-05.md](./open/real-provider-smoke-cli-2026-05.md) | Codex vendor ENOENT（precheck 已加）；Gemini `-y -p` 已默认化 | P0 Codex only |

---

> **2026-05-28 历史**：当时 issue5–8 均已收口。

## 收口动作（2026-05-28）

| 来源 | ID | 处理 |
|------|-----|------|
| issue6 | **6.8** | `resolveStepKind` + `tests/unit/step-strategy.test.ts` |
| issue6 | **6.10** | [`docs/architecture/trace-lifecycle.md`](../docs/architecture/trace-lifecycle.md) |
| issue6 | **6.11** | [`docs/architecture/execution-layers.md`](../docs/architecture/execution-layers.md) 取消契约 + abort 单测 |
| issue6 | **6.18** | `tests/unit/execution-failure-paths.test.ts`（无 result / IPC 拒绝） |
| issue5 | **5.10** | **WONTFIX** — `package.json` `comments.typescript-in-deps` |
| issue8 | **7.16** | 与 6.8 合并；新 step kind 时扩展 `StepKind` / `buildStructuredPromptForStep` |

## 文档索引（均已 `_close`）

| 文件 | 状态 |
|------|------|
| [archive/issue5_close.md](archive/issue5_close.md) | CLOSED |
| [archive/issue6_close.md](archive/issue6_close.md) | CLOSED |
| [archive/issue7_close.md](archive/issue7_close.md) | CLOSED |
| [archive/issue8_close.md](archive/issue8_close.md) | CLOSED |

## 后续入口

- 产品演进：**[ROADMAP.md#future](../ROADMAP.md#future)**（未排期项；Phase 0–8 见 [docs/history/roadmap-delivered-phases.md](../docs/history/roadmap-delivered-phases.md)）
- P 系列：**P0-TRIAGE** P1–P33 已收口，不开 P34
