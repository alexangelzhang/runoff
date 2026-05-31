# External Memory Backend (P3/P4)

Local file memory remains the **primary** store (`~/.llm-pipeline/memory/`). Optional remote backends mirror writes and support async search via `LayeredAgentMemory`.

## Backends

| `type` | Adapter | Notes |
|--------|---------|--------|
| `local` | (default) | File only |
| `http` | `HttpMemoryClient` | Generic `/v1/memories` contract |
| `mem0` | `Mem0MemoryClient` | REST paths for platform (`api.mem0.ai`) or OSS (`variant: "oss"`) |
| `zep` | `ZepMemoryClient` | Zep Cloud v2 session + graph search |

## Enable (Mem0)

```json
{
  "orchestration": {
    "memoryBackend": {
      "type": "mem0",
      "apiKey": "m0-…",
      "userId": "pipeline-user",
      "variant": "platform"
    }
  }
}
```

OSS self-hosted:

```json
{ "type": "mem0", "baseUrl": "http://127.0.0.1:8888", "variant": "oss" }
```

Env: `LLM_PIPELINE_MEM0_URL`, `LLM_PIPELINE_MEM0_OSS_URL`, `LLM_PIPELINE_MEMORY_API_KEY`, `LLM_PIPELINE_MEMORY_USER_ID`.

## Enable (Zep)

```json
{
  "orchestration": {
    "memoryBackend": {
      "type": "zep",
      "apiKey": "zep-…",
      "userId": "user-id",
      "sessionId": "optional-session"
    }
  }
}
```

Env: `LLM_PIPELINE_ZEP_URL` (default `https://api.getzep.com/api/v2`).

## Generic HTTP proxy

```json
{
  "orchestration": {
    "memoryBackend": {
      "type": "http",
      "baseUrl": "https://your-proxy.example",
      "apiKey": "optional-bearer-token",
      "userId": "optional-tenant-or-user"
    }
  }
}
```

Environment fallbacks:

- `LLM_PIPELINE_MEMORY_URL` — base URL when `baseUrl` omitted
- `LLM_PIPELINE_MEMORY_API_KEY` — Bearer token

## HTTP contract (generic `http` type)

| Method | Path | Body |
|--------|------|------|
| POST | `/v1/memories` | `{ "entry": MemoryEntry }` |
| POST | `/v1/memories/search` | `{ "query": MemoryQuery }` → `{ "entries": MemoryEntry[] }` |

Implement this thin proxy in front of Mem0, Zep, or a custom vector store. Pipeline hooks still use synchronous `retrieve()` on local disk; use `LayeredAgentMemory.retrieveMerged()` from tooling for hybrid search.

## Transport (P5)

| `transport` | Behavior |
|-------------|----------|
| `rest` (default path) | Always use REST adapters |
| `auto` | Try `mem0ai` / `@getzep/zep-cloud` on first use; fallback REST |
| `sdk` | Require SDK; fallback REST if not installed |

Optional install (not in repo `package.json`):

```bash
npm install mem0ai          # platform MemoryClient
npm install @getzep/zep-cloud
```

### SDK integration tests (P6)

```bash
npm install mem0ai @getzep/zep-cloud   # optional
export LLM_PIPELINE_MEMORY_API_KEY=…   # for live calls
npm run test:sdk-memory
```

CI optional gate: `CI_SDK_MEMORY=1 npm run ci:gates`

## MCP (TOP2)

- `llm_memory_status` — resolved backend + optional `probe=true`
- `llm_query_memory` — hybrid `retrieveMerged` search
- See [`memory-production.md`](memory-production.md)

## Code

- `src/orchestration/memory-factory.ts` — `createPipelineMemory(config, { pipelineSessionId })`
- `src/memory-backend-status.ts` — describe / probe / merged query helpers
- `src/orchestration/memory-transport.ts` — `LazyRemoteMemoryClient`, SDK probe
- `src/orchestration/http-memory-client.ts` — `HttpMemoryClient`, `LayeredAgentMemory`
- `src/orchestration/mem0-memory-client.ts` — Mem0 REST
- `src/orchestration/zep-memory-client.ts` — Zep REST
