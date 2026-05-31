# MCP host setup

Generate a copy-paste MCP block for **llm-pipeline** (no API keys required for mock pipelines).

## Quick

```bash
npm run setup:mcp
npm run setup:mcp -- --host cursor
npm run setup:mcp -- --host claude-desktop
```

Optional one-click (Claude Code only):

```bash
npm run setup:mcp -- --install --host claude-code
```

If `claude` CLI is missing, `--install` prints JSON instead of failing.

## Host notes

| Host | Action |
|------|--------|
| **Cursor** | Settings → MCP → add server; use `command` / `args` / `cwd` from JSON |
| **Claude Desktop** | Merge `mcpServers` into `claude_desktop_config.json` |
| **Claude Code** | `npm run setup:mcp -- --install --host claude-code` or manual `claude mcp add` |
| **Other** | Any MCP-capable host that supports stdio tools |

Entry point uses `npx tsx <repo>/src/index.ts` so you do not need `npm run build` for local dev.

## Verify

```bash
npm run dev
# In host: call llm_show_config or llm_run_pipeline (mock config)
```

See [getting-started-30min.md](guides/getting-started-30min.md).
