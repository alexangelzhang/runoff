# Real Provider Smoke — CLI 环境（待修复）

> **Status: PARTIAL**（Gemini argv 已在代码/文档默认 `-y -p`；Codex vendor 仍依赖本机重装 + precheck）  
> **发现场景**：本地 `npm run smoke:real:pre-release`  
> **报告目录**：`tmp/real-provider-smoke/local-20260531-175658/`

OTel pre-release gate（`pre-release:otel-gate`）已通过；4 个 real-provider case 均失败，根因在 **本机/Runner 的 CLI 安装与 argv 契约**，非 pipeline 主链逻辑。

---

## 已修（同次排查，无需再跟）

| 项 | 说明 |
|----|------|
| `run-real-provider-smoke.ts` `ROOT_DIR` | 由 `scripts/ts/..` 改为 `../../..`，否则找不到 `tests/integration/real-provider.integration.test.ts` |

---

## P0 — Codex：vendor 二进制缺失（ENOENT）

### 现象

- `codex-standalone`、`provider-race`、`provider-race-autopick` 的 `implement` 步失败。
- Trace 错误（例：`diagnostics/codex-standalone/.../traces/*.json`）：

  ```text
  spawn .../codex-darwin-arm64/vendor/.../codex/codex ENOENT
  spawnargs: [ 'exec', '--full-auto', '--skip-git-repo-check' ]
  ```

- 本机 `codex --version` 同样 ENOENT；vendor 目录为空。

### 根因

`@openai/codex` npm 包未完整安装（`vendor/.../codex/codex` 可执行文件缺失）。`which codex` 仅有 Node 包装入口。

### 建议修复（后续）

1. Runner / 开发机：`npm uninstall -g @openai/codex && npm install -g @openai/codex@latest`，确认 vendor 二进制存在。
2. 可选：smoke 前置检查（`precheck`）检测 vendor 路径或 `codex exec --help`。
3. 文档：`docs/operations/real-provider-smoke-runner-checklist.md` 增加「vendor 二进制存在」验收项。

---

## P0 — Gemini：argv 与 CLI 0.35+ headless 模式不匹配

### 现象

- `gemini-standalone` 约 15s 失败，`pipelineStatus: failed`。
- Trace 错误（`diagnostics/gemini-standalone/.../traces/*.json`）：

  ```text
  delegateArgv exited 42: Loaded cached credentials.
  No input provided via stdin. Use --prompt or pipe into gemini.
  ```

### 根因

- Pipeline 经 `scripts/python/task_runner.py` 的 `_run_delegate()` 将 **prompt 写入 stdin** 调用 CLI。
- 当前 smoke 示例 / 环境变量为 `RUNOFF_REAL_GEMINI_ARGV_JSON='["gemini"]'`。
- **Gemini CLI 0.35+** 默认交互模式；headless 需 `-p` / `--prompt`（`gemini --help`）。无 `-p` 时不消费 stdin 中的任务 prompt。

### 建议修复（后续）

1. 更新推荐 argv（仓库文档 + workflow secret 示例）：

   ```bash
   export RUNOFF_REAL_GEMINI_ARGV_JSON='["gemini","-y","-p"]'
   ```

   - `-y`：自动批准工具（smoke 无人值守）
   - `-p`：headless，并与 stdin 拼接（CLI 文档行为）

2. 同步修改：
   - `docs/operations/real-provider-smoke.md`
   - `tests/integration/real-provider.integration.test.ts` 头部注释
   - `docs/operations/real-provider-smoke-runner-checklist.md`

3. 可选：集成测试默认 argv 带 `-y -p`，或在 runner 对 `gemini` 无 `-p` 时 warn。

---

## P1 — Race 用例（依赖 P0）

| Case | 期望 | 实际 | 说明 |
|------|------|------|------|
| `provider-race` | `awaiting_judge` | `failed` | Codex ENOENT，implement 步顶满 300s timeout |
| `provider-race-autopick` | `approved` | `failed` | 同上，无法 auto-pick |

修好 Codex + Gemini argv 后重跑：

```bash
export RUNOFF_RUN_REAL_PROVIDER_SMOKE=1
export RUNOFF_REAL_CODEX_ARGV_JSON='["codex","exec","--full-auto","--skip-git-repo-check"]'
export RUNOFF_REAL_GEMINI_ARGV_JSON='["gemini","-y","-p"]'
npm run smoke:real:pre-release
```

---

## 验证清单（修复后）

- [ ] `codex exec --help` 或 vendor 二进制可执行
- [ ] `echo "ping" | gemini -y -p` 能 headless 执行（或等价 smoke 单用例）
- [ ] `npm run smoke:real:pre-release` 四 case 全绿
- [ ] self-hosted runner secrets/vars 与文档一致

---

## 相关文件

| 区域 | 路径 |
|------|------|
| 集成测试 | `tests/integration/real-provider.integration.test.ts` |
| CLI 委托 | `scripts/python/task_runner.py` (`_run_delegate`) |
| TS CLI Provider | `src/providers/cli.ts` |
| Smoke 文档 | `docs/operations/real-provider-smoke.md` |
| Runner 清单 | `docs/operations/real-provider-smoke-runner-checklist.md` |
