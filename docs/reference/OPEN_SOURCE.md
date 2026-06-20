# 开源发布指南

面向目标：**稳定 · 可观测 · 开箱即用 · 差异化清晰**（self-hosted MCP + CLI，非 SaaS）。

## 定位（对外一句话）

**Local harness for observable, recoverable coding-agent pipelines** — repo worktrees, durable run control, races, schema-versioned observations, local traces.
详见 [`differentiation.md`](reference/differentiation.md)（含 **AutoGen** 对比）。

## 5 分钟体验（零 API Key）

```bash
git clone <repo-url> runoff && cd runoff
npm install
npm run demo
```

## 真实 coding agent（非 Cursor 限定）

| 步骤 | 文档 |
|------|------|
| 复制 `examples/configs/cli.config.json` | [`coding-agent-backends.md`](guides/coding-agent-backends.md) |
| Codex / Gemini / Claude Code / OpenCode | 同上 |
| 无 IDE：`pipeline run` | `npm run runoff:run -- --prompt "…" --work-dir .` |

## 稳定

| 门禁 | 命令 |
|------|------|
| 全量单测 | `npm test` |
| CI 捆绑 | `npm run ci:gates`（含 `examples/configs/*.config.json` doctor） |
| PR smoke | `npm run ci:gates:smoke`（无 secrets 时 allow-skip；有 secrets 时 workflow 跑 strict） |
| PR smoke（严格） | `npm run ci:gates:smoke:strict` |
| 发版 tag `v*` | `.github/workflows/release.yml` → gates + pre-release smoke（self-hosted，无 skip） |
| 发版前（本地） | `npm run smoke:real:pre-release` |

详见 [`ci-branch-protection.md`](operations/ci-branch-protection.md)、[`supported-backends.md`](reference/supported-backends.md)、[`timeouts.md`](operations/timeouts.md)、[`stability-boundaries.md`](operations/stability-boundaries.md)。

| 本地 soak（可选） | `npm run runoff:soak` |
| OTel 导出自检 | `npm run verify:otel-export` |
| OTel Collector（无 Docker） | `npm run otel-collector:start` · [`observability-collector-local.md`](operations/observability-collector-local.md) |
| 示例禁实验特性 | `npm run check:examples-experimental` |

## 可观测（默认主路径）

| 数据 | 路径 | MCP |
|------|------|-----|
| Observation | `PipelineResult.observation` / `StepResult.observation` | `runoff_run_pipeline` JSON body |
| Run control | `~/.runoff/control-plane/` | `runoff_query_runs` / `npm run runoff:runs -- list` |
| Trace | `~/.runoff/traces/` | `runoff_query_traces` |
| Experiment | `~/.runoff/experiments.jsonl` | `runoff_query_experiments` |

详见 [`observability.md`](features/observability.md)。

## 开源清单

- [x] `LICENSE`（MIT）
- [x] `CHANGELOG.md`
- [x] `CONTRIBUTING.md`
- [x] `docs/reference/differentiation.md`（含 AutoGen）
- [x] `docs/guides/coding-agent-backends.md`
- [x] `examples/configs/quickstart.config.json` + `examples/configs/cli.config.json`
- [x] `npm run demo`
- [x] `scripts/ts/dev/pipeline-cli.ts` / `npm run runoff:run`
- [x] `.github/workflows/release.yml`（tag `v*`）
- [ ] CI badge URL（发布到 GitHub 后替换 README 中的 `<repo-url>`）
- [x] `npm run typecheck` 全绿（CI `ci:gates` 已包含）
- [x] `docs/guides/getting-started-30min.md` + `docs/advanced/README.md`
- [x] `docs/architecture/security-model.md` + `npm run check-prereqs`
- [x] `examples/configs/{feature,bugfix,refactor}.config.json` + `examples/README.md`
- [x] `examples/observation-result.json` + Observation layer docs
- [x] `.github/pull_request_template.md`
- [x] `npm run setup:mcp` + `docs/guides/mcp-host-setup.md`
- [x] `pipeline init` / `doctor` / `config validate` + `docs/guides/mock-to-real-cli.md`
- [x] `pipeline runs list|show` CLI + `runoff_query_runs` MCP control-plane query
- [x] Full config graphical editor (providers + DAG + retry + runtime) via `pipeline:config:edit`
- [x] `pipeline race apply|abort` CLI + `runtime.raceFinalize: auto-pick`
- [x] Optional `.devcontainer` — [devcontainer.md](operations/devcontainer.md)

## 明确非目标

- 多租户托管、Web 控制台
- **Docker / devcontainer**（暂不提供的镜像）
- MCP 层统一 OAuth
- A2A 联邦生产级 HA
- 克隆 LangSmith UI
