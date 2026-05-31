# Real Provider Smoke

`tests/integration/real-provider.integration.test.ts` 负责打真实 CLI provider 的 opt-in 集成 smoke；`src/pipeline/real-provider-smoke-runner.ts` 提供 runner 参数解析与汇总判定；`scripts/ts/dev/run-real-provider-smoke.ts` 负责把这组测试包装成可落地的 runner；`tests/unit/real-provider-smoke.test.ts` 在常规 `npm test` 中校验 runner 契约（无需真实 CLI）：生成汇总报告、失败诊断和 sandbox artifact，并提供 `manual`、`nightly`、`pre-release` 三种执行模式。

## CI / 发版背书矩阵

| 场景 | 命令 | 无 secret 时 |
|------|------|----------------|
| 本地联调 | `npm run smoke:real` | 可 `--allow-skip` |
| PR smoke | `npm run ci:gates:smoke` | allow-skip（默认） |
| 发版前 | `npm run smoke:real:pre-release` | **失败**（不 skip） |
| 夜间 | `npm run smoke:real:nightly` | **失败**（不 skip） |

对外宣称支持的 CLI backend 应在发版说明中注明最近一次 `pre-release` 通过日期。详见 [`real-provider-smoke-runner-checklist.md`](operations/real-provider-smoke-runner-checklist.md)。

## 什么时候跑

- `manual`：本地联调。默认允许 skip，适合先验证 runner、报告链路和环境注入是否正确。
- `nightly`：夜间健康检查。默认开启 race，任何 skip 都视为失败。
- `pre-release`：发版前 gate。与 nightly 一样严格，但建议在 release pipeline 或人工发布流程里调用。

## 命令

```bash
npm run smoke:real
npm run smoke:real:nightly
npm run smoke:real:pre-release
```

也可以直接运行 runner：

```bash
node --import tsx scripts/ts/dev/run-real-provider-smoke.ts --mode manual --allow-skip
node --import tsx scripts/ts/dev/run-real-provider-smoke.ts --mode nightly --report-dir tmp/real-provider-smoke/manual-check
```

## 需要的环境变量

必填：

- `LLM_PIPELINE_RUN_REAL_PROVIDER_SMOKE=1`
- `LLM_PIPELINE_REAL_CODEX_ARGV_JSON`
- `LLM_PIPELINE_REAL_GEMINI_ARGV_JSON`：仅当需要 Gemini standalone 或 race 时必须提供

常用可选项：

- `LLM_PIPELINE_RUN_REAL_RACE_SMOKE=1`：直接跑 `test:real-providers` 时控制 race 用例；通过 runner 时会由 `--mode` 自动注入
- `LLM_PIPELINE_REAL_TIMEOUT_MS`：覆盖 provider timeout
- `LLM_PIPELINE_REAL_SMOKE_KEEP_SANDBOX=1`：直接跑 `test:real-providers` 时保留 sandbox；通过 runner 时默认保留到汇总完成，再按结果决定是否清理

示例：

```bash
export LLM_PIPELINE_RUN_REAL_PROVIDER_SMOKE=1
export LLM_PIPELINE_REAL_CODEX_ARGV_JSON='["codex","exec","--full-auto","--skip-git-repo-check"]'
export LLM_PIPELINE_REAL_GEMINI_ARGV_JSON='["gemini","-y","-p"]'
export GEMINI_API_KEY='...'

npm run smoke:real
```

## 报告和失败产物

默认报告目录：`tmp/real-provider-smoke/<timestamp>-<mode>/`

关键产物：

- `summary.json`：机器可读汇总
- `summary.md`：给人看的总览
- `invocation.json`：本次 runner 注入的模式和路径
- `logs/stdout.log`、`logs/stderr.log`：原始测试输出
- `cases/*.json`：每个 smoke case 的 metadata
- `diagnostics/runner/`：runner 自身上下文、当前仓库状态和报告目录树
- `diagnostics/<case-id>/`：单 case 的 repo diff、sandbox tree、home 快照、pipeline config
- `sandboxes/`：失败时保留完整 sandbox；成功且未指定 `--keep-success-sandboxes` 时会自动清理

失败排查通常直接看这三处：

1. `summary.md`
2. `diagnostics/<case-id>/repo-diff.patch`
3. `diagnostics/<case-id>/home-snapshots/{traces,sessions,tasks}/`

## GitHub Actions 建议

仓库里提供了 `.github/workflows/real-provider-smoke-nightly.yml` 和 `.github/workflows/real-provider-smoke-pre-release.yml`。前者用于持续健康检查，后者用于发布前 gate。两个 workflow 都默认面向带有真实 CLI 和认证环境的 self-hosted runner，建议准备一个专用 label，例如 `llm-pipeline-real-smoke`。

建议至少配置这些 secrets：

- `LLM_PIPELINE_REAL_CODEX_ARGV_JSON`
- `LLM_PIPELINE_REAL_GEMINI_ARGV_JSON`
- `GEMINI_API_KEY`：如果 Gemini CLI 依赖 API key
- `OPENAI_API_KEY`：如果你的 Codex 运行方式需要

如果 Codex CLI 依赖本地登录态，nightly runner 需要预先完成登录，不建议直接放到 GitHub-hosted runner 上临时拉起。
