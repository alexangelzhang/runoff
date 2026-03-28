---
name: dev-pipeline
description: "Multi-LLM orchestration pipeline with retry loops, smart routing, race mode, and response caching"
---

# Dev Pipeline Skill

You are orchestrating a multi-LLM development pipeline. Call `llm_show_config` first to see the current configuration.

## Quick Start

For most tasks, use `llm_run_pipeline` which handles the full flow automatically:

```
llm_run_pipeline(prompt: "...", language: "python")
```

This runs all steps in order, retries on review rejection, uses smart routing, and caches results.

## Execution Modes

### Pipeline Mode (default)
Sequential execution: steps run in `order`, review step triggers retry if rejected.

```
llm_run_pipeline(prompt: "...", mode: "pipeline")
```

### Race Mode
Parallel execution: multiple providers generate simultaneously, Claude picks the best.

```
llm_run_pipeline(prompt: "...", mode: "race")
```

## Available Tools

| Tool | Purpose |
|------|---------|
| `llm_run_pipeline` | Full pipeline with retry, routing, and caching |
| `llm_run_step` | Execute a single step (with cache) |
| `llm_show_config` | Show config, routing rules, and cache stats |

## Pipeline Flow

```
[1] generate (codex/gemini/openai) → [2] review (gemini/openai)
         ↑                                    ↓
         └──── retry with feedback ←── NEEDS_REVISION?
                (up to maxRounds)
```

## Smart Routing

When `routing` rules are configured, the pipeline automatically picks the best provider based on prompt complexity:
- **low** complexity → fast/cheap provider (e.g. gemini)
- **medium/high** complexity → powerful provider (e.g. codex)

## Response Cache

Identical prompts to the same provider return cached results (TTL: 30min, LRU: 64 entries). Cache stats are included in `llm_show_config` and pipeline results.

## Configuration

Edit `pipeline.config.json` to customize:

```json
{
  "pipeline": {
    "generate": { "provider": "codex", "order": 1 },
    "review":   { "provider": "gemini", "order": 2 }
  },
  "retry": { "maxRounds": 2, "reviewStep": "review" },
  "routing": [
    { "complexity": "low", "provider": "gemini" },
    { "complexity": "high", "provider": "codex" }
  ],
  "modes": {
    "race": { "type": "race", "providers": ["codex", "gemini"], "judge": "claude" }
  }
}
```
