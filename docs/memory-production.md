# External Memory — Production Checklist (Phase 9+ TOP2)

Local disk (`~/.llm-pipeline/memory/`) remains the **source of truth** for pipeline hooks. Remote backends (Mem0 / Zep / HTTP) mirror writes and support **async** hybrid search.

## MCP tooling

| Tool | Purpose |
|------|---------|
| `llm_memory_status` | Resolved backend type, credentials presence, read path; optional `probe=true` |
| `llm_query_memory` | `retrieveMerged` — local + remote search for ops/debug |
| `llm_show_config` | Includes `memoryBackend` summary |

## Configure

See [`external-memory.md`](external-memory.md) for JSON examples.

**Zep session**: set `orchestration.memoryBackend.sessionId`, or pass `sessionId` to `llm_memory_status` / `llm_query_memory` (falls back to pipeline run `sessionId` when probing/querying).

## Read vs write paths

| Path | Behavior |
|------|----------|
| Pipeline hooks / `PatternCache` | Start: async semantic match via `retrieveMerged` when layered (M1); exact hash still sync local |
| `llm_query_memory` | Async `retrieveMerged()` — local + remote |
| `store()` | Always local first; remote `push` is best-effort async |

### M1 config

```json
{
  "orchestration": {
    "memoryHybridRetrieve": true,
    "memoryHybridRetrieveTimeoutMs": 800
  }
}
```

Disable hybrid read: `"memoryHybridRetrieve": false`. Local-only backends ignore hybrid (no layered memory).

## Production checklist

1. Set `memoryBackend.type` and env fallbacks (`LLM_PIPELINE_MEMORY_API_KEY`, etc.).
2. Run `llm_memory_status` with `probe=true` before enabling in CI agents.
3. Use `llm_query_memory` to verify remote search returns expected entries.
4. Do not rely on remote-only reads during hot pipeline path until hooks adopt async enrichment (future).

## Code

- `src/memory-backend-status.ts` — describe, probe, `queryPipelineMemoryMerged`
- `src/orchestration/memory-factory.ts` — `resolveMemoryBackendConfig(config, { pipelineSessionId })`

## 后续：Dream 离线整理

见 [`memory-dream-roadmap.md`](memory-dream-roadmap.md)（Evolution 主战场；与 personal-vault 知识库无集成义务）。

## Dreamify (M3)

检索调参：[`dreamify.md`](dreamify.md) · MCP `llm_dreamify_tune`。
