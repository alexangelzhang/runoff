# DeerFlow-style reflect → re-plan (narrow MVP)

## Scope

| In scope | Out of scope |
|----------|--------------|
| `review_revision` — review 未通过，下一轮前 re-plan | 每步自动 reflect |
| `step_failure` — step 失败且未 approved，下一轮前 re-plan | 动态增删 config 外 step |
| LLM reflect provider + 规则 fallback | 替换 `pipeline.config.json` SoT |
| `plan_revision` event-log 记录 | LangGraph 运行时 |

## Config

```json
{
  "orchestration": {
    "mode": "llm-driven",
    "plannerProvider": "planner",
    "reflect": {
      "enabled": true,
      "provider": "planner",
      "onReviewRevision": true,
      "onStepFailure": true
    }
  }
}
```

- `reflect.enabled` 仅对 `llm-driven` 生效。
- `provider` 省略时使用 `plannerProvider`。
- Mock provider 支持 step `orchestrator-reflect`（与 `orchestrator-plan` 类似）。

## Flow

1. Round 结束且未 `approved`、未超 `maxRounds`。
2. 若 `stepFailed` → trigger `step_failure`，否则 `review_revision`。
3. `LLMOrchestrator.reflectAndReplan()` → `applyExecutionPlanToAgentGraph` + `syncExecutionPlanFromAgentGraph`。
4. 成功则清除 `stepFailed`，进入下一轮。

## Code

- `src/orchestration/reflect-planner.ts` — LLM prompt + JSON parse
- `src/orchestration/reflect.ts` — `applyReflectReplan`
- `src/orchestration/orchestrator.ts` — `reflectAndReplan`
- `src/orchestration/pipeline-runner.ts` — round-end hook

## Tests

```bash
npx tsx --test tests/reflect-planner.test.ts tests/llm-orchestrator.test.ts
```
