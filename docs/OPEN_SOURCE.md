# 开源发布指南

面向目标：**稳定 · 可观测 · 开箱即用 · 差异化清晰**（self-hosted MCP + CLI，非 SaaS）。

## 定位（对外一句话）

**Multi-step code-change pipelines for coding agents** — repo worktrees, races, local traces.  
详见 [`differentiation.md`](differentiation.md)（含 **AutoGen** 对比）。

## 5 分钟体验（零 API Key）

```bash
git clone <repo-url> llm-pipeline && cd llm-pipeline
npm install
npm run demo
```

## 真实 coding agent（非 Cursor 限定）

| 步骤 | 文档 |
|------|------|
| 复制 `examples/cli.config.json` | [`coding-agent-backends.md`](coding-agent-backends.md) |
| Codex / Gemini / Claude Code / OpenCode | 同上 |
| 无 IDE：`pipeline run` | `npm run pipeline:run -- --prompt "…" --work-dir .` |

## 稳定

| 门禁 | 命令 |
|------|------|
| 全量单测 | `npm test` |
| CI 捆绑 | `npm run ci:gates` |
| PR smoke | `npm run ci:gates:smoke` |
| 发版前（可选） | `npm run smoke:real:pre-release` |

## 可观测（默认主路径）

| 数据 | 路径 | MCP |
|------|------|-----|
| Trace | `~/.llm-pipeline/traces/` | `llm_query_traces` |
| Experiment | `~/.llm-pipeline/experiments.jsonl` | `llm_query_experiments` |

详见 [`observability.md`](observability.md)。

## 开源清单

- [x] `LICENSE`（MIT）
- [x] `CHANGELOG.md`
- [x] `CONTRIBUTING.md`
- [x] `docs/differentiation.md`（含 AutoGen）
- [x] `docs/coding-agent-backends.md`
- [x] `examples/quickstart.config.json` + `examples/cli.config.json`
- [x] `npm run demo`
- [x] `scripts/ts/dev/pipeline-cli.ts` / `npm run pipeline:run`
- [x] `.github/workflows/release.yml`（tag `v*`）
- [ ] CI badge URL（发布到 GitHub 后替换 README 中的 remote）
- [ ] `npx tsc --noEmit` 全绿（历史债务；运行时用 tsx）

## 明确非目标

- 多租户托管、Web 控制台
- **Docker / devcontainer**（暂不提供的镜像）
- MCP 层统一 OAuth
- A2A 联邦生产级 HA
- 克隆 LangSmith UI
