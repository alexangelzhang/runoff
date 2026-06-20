# Mock → real coding-agent CLI

## Ladder

| Step | Command |
|------|---------|
| 1. Prerequisites | `npm run check-prereqs` |
| 2. Scaffold config | `npm run runoff:init -- --work-dir /path/to/repo --profile feature` |
| 3. Health check | `npm run runoff:doctor -- --config /path/to/repo/pipeline.config.json` |
| 4. Edit graph + providers | `npm run runoff:config:edit -- --config ...` |
| 5. Real CLIs | `npm run runoff:init -- --profile cli-detected` or copy `examples/configs/cli.config.json` |
| 6. Run | `npm run runoff:run -- --prompt "..." --work-dir /path/to/repo --config ...` |

## Profiles (`pipeline init`)

| Profile | Use |
|---------|-----|
| `mock` / `feature` | Safe default (mock implement + review) |
| `bugfix` / `refactor` | Example topologies |
| `cli-detected` | Keeps only providers whose `command` is on PATH (+ mock reviewer) |

## Provider race

| `runtime.raceFinalize` | Behavior |
|------------------------|----------|
| `defer` (default) | Pipeline pauses at `awaiting_judge`; finalize with `npm run runoff:race:apply` or MCP `runoff_race_apply` |
| `auto-pick` | Applies `resolveProviderRaceWinner` choice immediately (CI / experiments) |

```bash
npm run runoff:race:apply -- --session <checkpointId> --winner 0
npm run runoff:race:abort -- --trace-id <traceId> --reason "reject all"
```

Set in the config editor **Runtime** tab or JSON: `"runtime": { "raceFinalize": "auto-pick" }`.

## MCP

Register the server once: [mcp-host-setup.md](guides/mcp-host-setup.md).

## Real-provider smoke (maintainers)

[real-provider-smoke.md](operations/real-provider-smoke.md)
