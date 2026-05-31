# Project Lessons

项目级经验知识库。记录踩过的坑和验证有效的解法，供后续任务自动匹配。

## Entry 格式

每条经验用 Trigger → Do → Why 三段式，方便 `/bitlesson` 按 Trigger 精确匹配当前任务。

```markdown
## BL-YYYYMMDD-short-name
- Scope: <涉及的组件/文件/子系统>
- Trigger: <什么情况下会踩这个坑——具体的操作、文件模式、错误信号>
- Do: <遇到 Trigger 时应该怎么做——具体操作步骤>
- Why: <为什么这样做——根因分析，不超过两句>
- Evidence: <验证手段——测试/命令/日志/PR>
```

**写法要求：**
- Trigger 必须是可匹配的条件（"修改 X 文件时"、"出现 Y 错误时"、"新增 Z 类型的模块时"），不是泛泛的描述
- Do 必须是具体动作（"先跑 xxx 命令"、"检查 xxx 配置"），不是原则性建议
- Why 解释根因，帮助判断边界情况是否适用

## Entries

## BL-20260531-mcp-iserror-semantics
- Scope: `src/tools/mcp-response.ts`, all `llm_*` tools
- Trigger: 解析 MCP 工具返回值时只看 `isError`，或假设 race/pipeline 成功时 `isError` 必为 false
- Do: 始终 `JSON.parse(content[0].text)`；pipeline 看 `status`（`awaiting_*` 时 `isError` 为 false；`failed`/`aborted`/`max_rounds` 为 true）；race 成功时检查 `cleanupErrors` 数组，不要仅用 `isError`
- Why: `isError` 只标记 MCP 层异常/终端失败；部分清理警告在 body 里，不算 tool error
- Evidence: `skill/SKILL.md` MCP response contract；`tests/unit/mcp-response.test.ts`

## BL-20260531-memory-hybrid-opt-in
- Scope: `src/pipeline/pipeline-hooks.ts`, `orchestration.memoryHybridRetrieve`
- Trigger: 期望 pipeline 热路径自动走远程 memory HTTP 检索
- Do: 在 `pipeline.config.json` 显式设 `orchestration.memoryHybridRetrieve: true`；先用 `llm_memory_status probe=true` 验证后端
- Why: G5 治理后 hybrid 默认关闭，热路径仅本地 pattern cache
- Evidence: `docs/architecture/memory-layers.md`；`tests/unit/pipeline-memory-m1.test.ts`

