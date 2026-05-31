# 30-minute landing guide

Goal: run a **mock pipeline** (no API keys), then understand how to point at a **real git repo** with coding-agent CLIs.

## 0–5 min — Prerequisites

```bash
bash scripts/shell/check-prereqs.sh   # or: npm run check-prereqs
cd llm-pipeline && npm install
npm run setup:mcp -- --host cursor    # optional: MCP JSON for your IDE
npm run demo
```

You should see an **approved** mock run. Data lands under a temp `LLM_PIPELINE_HOME` (trace + experiment).

## 5–10 min — What just happened

| Piece | Role |
|-------|------|
| `pipeline.config.json` | Declares steps, providers, deps |
| MCP / `pipeline run` | Starts the DAG |
| `scripts/python/task_runner.py` | Runs CLI providers in worktrees |
| `~/.llm-pipeline/traces/` | Local execution history |

Read: [`differentiation.md`](reference/differentiation.md) (why not LangGraph/CrewAI chat loops).

## 10–20 min — Config on your repo (mock reviewer)

1. Scaffold config (or copy an example):

```bash
npm run pipeline:init -- --work-dir /path/to/your-repo --profile feature
npm run pipeline:doctor -- --config /path/to/your-repo/pipeline.config.json
```

**Graphical editor (recommended):** providers + DAG + retry tabs:

```bash
npm run pipeline:config:edit -- --config /path/to/your-repo/pipeline.config.json
```

Opens a browser → edit steps/providers/deps → **Save to config** (local HTTP, no MCP).

2. From llm-pipeline checkout:

```bash
npm run pipeline:run -- \
  --prompt "Add a hello() function with a unit test" \
  --work-dir /path/to/your-repo \
  --config /path/to/your-repo/pipeline.config.json
```

`examples/configs/feature.config.json` uses **mock** implement + review — safe without Codex/Gemini installed.

## 20–30 min — Real coding agents (optional)

1. Copy [`examples/configs/cli.config.json`](../examples/configs/cli.config.json) and edit `providers` for tools you have installed.
2. Follow [`coding-agent-backends.md`](guides/coding-agent-backends.md).
3. Query results:

```bash
npm run dev   # MCP — register in IDE per README
# or inspect files under ~/.llm-pipeline/traces/
```

## Implement → review → retry loop

Typical `pipeline` shape:

```json
{
  "pipeline": {
    "implement": ["codex"],
    "review": ["reviewer", "implement"]
  },
  "retry": { "maxRounds": 3, "reviewStep": "review" }
}
```

When review fails, the pipeline retries implement with feedback (see trace `steps[]`).

## Next steps

| Topic | Doc |
|-------|-----|
| MCP tools | [README](../README.md#mcp-tools) |
| Observability | [observability.md](features/observability.md) |
| Governance | [governance-config.md](architecture/governance-config.md) |
| Advanced (A2A, Dream) | [advanced/README.md](../advanced/README.md) |
