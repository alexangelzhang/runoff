# CLAUDE.md — runoff project instructions

## Token Efficiency Rules

### File Reading
- NEVER read `src/index.ts` in full — use Grep to locate the target section, then Read with `offset`+`limit`
- For any file > 200 lines, Grep first, Read the specific range
- After editing, verify with Grep (pattern match) instead of re-reading the whole file
- Don't re-read a file that hasn't changed since the last read in the current context

### Search
- Always scope Glob/Grep with `path` parameter — never search from repo root without it
- Use `path: "src"` or `path: "tests"` to avoid hitting node_modules
- Prefer `output_mode: "content"` with `head_limit` over unbounded searches

### Editing
- Prefer Edit (surgical replacement) over Write (full file rewrite)
- Include enough surrounding context in `old_string` to be unique, but not entire functions

## Project Structure

```
src/index.ts           — MCP server entry point, tool registration (~57 lines)
src/tools/run-step.ts  — llm_run_step tool (single step execution)
src/tools/run-pipeline.ts — llm_run_pipeline tool registration (thin; logic in pipeline-mcp-run.ts)
src/tools/race.ts      — llm_race_apply / llm_race_abort tools (race session finalization)
src/tools/show-config.ts — llm_show_config tool
src/tools/query-traces.ts — llm_query_traces tool
src/tools/helpers.ts   — Serialization helpers, race session registry (PipelineParams in core/pipeline-run-types.ts)
src/core/              — config, ipc, state, paths, candidate, verdict, logger
src/runtime/           — workspace, pipeline-workdir, race-registry, race-execution
src/routing/           — router, cache, pricing, retry, circuit breaker
src/observability/     — trace, experiment-log, prompt-version, trace-exporter
src/memory/            — pipeline-memory, dream-state, memory-backend-status
src/pipeline/          — pipeline-hooks, prompt composer, real-provider smoke
src/infra/ast_utils.ts — TypeScript syntax check at runtime
src/providers/cli.ts   — CLI provider, bridges TS↔Python via JSON files
src/providers/types.ts — LLMRequest, LLMResponse (TextResponse | AgentResponse), ProviderMode
src/orchestration/     — DAG, agents, governance, durable CP (see docs/architecture/structure.md)
scripts/python/task_runner.py — Python task execution (subprocess, worktree, patch, lock)
scripts/python/workspace_manager.py — Centralized workspace backend (worktree, lock, patch apply)
scripts/shell/watcher.sh     — Watcher process for polling task files
scripts/ts/ci/check-ipc-sync.ts — CI helper: TS/Python IPC constants must match
```

## Architecture

- TypeScript: MCP tool API, orchestration, routing, retry, candidate state, trace, judge
- Python: subprocess execution, timeout management, diff collection, workspace management (worktree + locking)
- IPC: file-based JSON (`*.task.json` → `*.result.json`), schema in `src/core/ipc.ts`
- Shared schema enforced by `tests/unit/ipc-schema.test.ts` — adding IPC fields requires updating both sides
- **`npm run check-ipc-sync`** — compares `src/core/ipc.ts` with `scripts/python/task_runner.py` (schema versions + field manifests); run after IPC changes
- **`typescript` in `dependencies`** (not only devDependencies) because `src/infra/ast_utils.ts` imports the compiler API (`import ts from "typescript"`) for `isSyntaxValid` at runtime in the MCP server
- Layer map: **`docs/architecture/structure.md`**
- Workspace isolation: Python `workspace_manager.py` owns all physical git worktree ops and cross-process locking

## Testing

- Run all: `npm test` (`tests/**/*.test.ts`)
- Run single: `npx tsx --test tests/unit/<name>.test.ts` (or `tests/e2e/`, `tests/federation/`, `tests/integration/`)
- ~540 tests, smoke tests involve git worktree ops (~10s)

## Common Tasks → Files

| 要做什么 | 看哪里 |
|----------|--------|
| 加新 MCP tool | `src/tools/` 新建 .ts → `src/index.ts` 注册 |
| 改 MCP pipeline 会话 | `src/orchestration/pipeline-mcp-run.ts`；工具注册 `src/tools/run-pipeline.ts` |
| 改单步执行 | `src/tools/run-step.ts`；核心逻辑 `src/orchestration/step-execution.ts` |
| 改 race mode | `src/tools/race.ts` → `src/tools/helpers.ts`（race session registry） |
| 改 provider 路由 / 复杂度评分 | `src/routing/router.ts` |
| 改 IPC 协议 | `src/core/ipc.ts`（TS 侧）→ `scripts/python/task_runner.py`（Python 侧）→ 跑 `npm run check-ipc-sync` |
| 改 workspace 隔离 | `src/runtime/workspace.ts`（TS 委托）→ `scripts/python/workspace_manager.py`（Python 实现） |
| 改 checkpoint / 状态恢复 | `src/core/state.ts` |
| 改 trace 记录 / 查询 | `src/observability/trace.ts` → `src/tools/query-traces.ts` |
| 改 LRU 缓存 | `src/routing/cache.ts` |
| 改 candidate 模型 | `src/core/candidate.ts` |
| 改 orchestration / OODA loop | `src/orchestration/orchestrator.ts` |
| 改 AgentGraph 编译/动态注入 | `src/orchestration/agent-graph.ts` |
| 改编排层单步 / Agent 执行 (B8) | `step-execution.ts`, `pipeline-step-agent.ts`, `step-runner.ts` |
| Provider race 合并 | `src/orchestration/race-merge.ts` |
| 并行 stage 合并 | `src/orchestration/stage-merge.ts` |
| AgentGraph 导出/编辑/可视化 | `agent-graph-io.ts`、`agent-graph-viz.ts`；MCP `llm_show_agent_graph` |
| 外置记忆 HTTP | `memory-factory.ts`、`http-memory-client.ts` |
| A2A 联邦 HA/鉴权 | `federation-ha.ts`、`docs/features/a2a-federation.md` |
| Pipeline Hooks | `src/pipeline/pipeline-hooks.ts` |
| 改 A2A 联邦同步 (B5) | `src/experimental/a2a/federation-sync.ts`（兼容：`experimental/a2a/` 重导出） |
| 改 agent 抽象 | `src/orchestration/agent.ts` / `agent-state.ts` / `registry.ts` |
| 改治理框架 | `src/orchestration/policy.ts` / `approval.ts` / `guardrails.ts` / `guardrail-scan.ts` |
| 改 Python 执行后端 | `scripts/python/task_runner.py`（子进程）→ `scripts/python/workspace_manager.py`（worktree + lock） |
| 改 A2A HTTP/mTLS/发现/联邦 | `src/experimental/a2a/http-transport.ts`, `external-registry.ts`, `federated-registry-store.ts` |
| CI gates | `npm run ci:gates`（`scripts/ts/ci/run-ci-gates.ts`）, `npm run test:gates` |
| 行业对标钉版本 | `npm run check-benchmark-pins`（ci:gates）；刷新 `npm run refresh-benchmark-pins` |
| 改 prompt 版本回放 | `src/observability/prompt-version.ts`（`~/.runoff/prompt-versions/`） |
| 改 trace 实体图 | `src/orchestration/trace-entities.ts` |
| OTel OTLP 导出 | `src/observability/trace-exporter.ts`（`runtime.otelEndpoint`, `OTEL_EXPORTER_OTLP_ENDPOINT`） |
| Orchestrator 驱波 | `src/orchestration/plan-scheduler.ts`, `pipeline-execution.ts` → `executionPlan` |

## 不要做的事

- 不要修改 src/core/ipc.ts 而不同步更新 scripts/python/task_runner.py（跑 npm run check-ipc-sync 验证）
- 不要在 src/tools/run-pipeline.ts 里堆编排逻辑 — 新功能放到 `src/orchestration/` 或 `src/pipeline/`
- 不要删除 mock provider（tests 依赖它）
- 不要改 workspace isolation 逻辑而不跑 smoke tests
- 测试里不能用 `type: "openai"` 或 `type: "anthropic"` 的 provider config——`createProvider` 会立即构造客户端并验证 API key，没有 key 会抛异常。用 `type: "cli"（command: "echo"）` 或 `type: "mock"` 代替

## 架构陷阱

**DAGOrchestrator 短路 review verdict**：`DAGOrchestrator.onStepComplete` 在所有步骤完成时返回 `{type:"done", success:true}`，这会在 `if (orchestrator && orchestrationContext)` 分支里直接 `state.approved = true; break`，导致 review step 的 `NEEDS_REVISION` verdict 永远不被处理。

DAG 模式下 retry 不是 review-driven 的——它只通过 `stepFailed=true`（implement 步骤 response.failed）触发，而 stepFailed 会立即让 finalStatus=failed（不是 retry）。真正的 review-driven retry 只在 `llm-driven` orchestration 模式下有效。

**影响**：mock provider 的 review 差异化测试在 DAG 模式下无效，测不出 retry 轮次差异。benchmark 数据只能反映 token 成本，不反映质量差异。

**opencode 在 linked worktree 里追溯源仓库（已修复）**：opencode 通过 `.git` 文件追溯到源仓库，忽略 worktree 内的目标代码。已通过在 `task_runner._execute_delegate_or_stub` 里注入 `--dir <exec_dir>` 修复——`exec_dir` 是 worktree 创建后才确定的实际工作目录。

**注意**：不能在 `cli.ts` 里注入 `--dir req.workDir`——`req.workDir` 是原始 repo 路径，会让 opencode 直接写原始仓库，绕过 worktree 隔离。必须在 task_runner.py 的 `_inject_dir_flag()` 里注入，时机是 worktree 创建之后。

**`git apply --3way` 对新建文件失败**：新文件不在 base commit 里，`--3way` 无法计算三方合并基准，报 "does not exist in index"。patch 内容本身正确，直接用 `git apply`（不带 `--3way`）或手动复制文件可以绕过。已修复（task_runner + workspace_manager 均加了 fallback）。

**Gemini CLI agent-write**：v0.44.x TUI 无法程序化驱动（pty 写入不响应）。v0.45.0+ 支持 ACP（`--acp` flag，JSON-RPC over stdio），已实现 `_run_delegate_acp()`。provider config 加 `"acp": true` 即可启用，内置版本检测会在运行时报错并给出升级命令。

**ACP delegate commit 行为（已修复）**：`_run_delegate_acp()` 在 session/prompt 完成后自动运行 `git add -A && git commit -m "acp: delegate changes"`，与 Claude Code / opencode 保持一致。修复前 Gemini ACP 改了文件但不 commit，导致 `workspacePath=n/a`，race apply 走不了 worktree 路径。
