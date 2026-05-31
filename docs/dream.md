# Dream Worker (M2)

Offline memory **Evolution** pass: structure traces (A) → rule updates (B) → optional LLM enrich (C).

Not run on the hot pipeline path. Trigger via MCP `llm_dream_run` or import `runDreamWorker`.

## Tracks

| Track | Module | Description |
|-------|--------|-------------|
| **A** | `dream-structured.ts` | Deterministic `DreamBatchItem` from `experiments.jsonl` + trace files |
| **B** | `dream-rules.ts` | ADD/UPDATE patterns, LESSON on failure, CONTRADICT patterns, FEEDBACK relevance, FORGET decay/TTL |
| **C** | `dream-llm.ts` | Optional LLM proposals (`lesson`, `trace_summary`) via `dream-enrich` step |

## Artifacts

| Path | Purpose |
|------|---------|
| `~/.llm-pipeline/dream-state.json` | `lastDreamAt` cursor |
| `~/.llm-pipeline/dream-audit.jsonl` | One JSON line per rule/audit action |
| `~/.llm-pipeline/memory/` | Local memory (source of truth) |

## Config

```json
{
  "orchestration": {
    "dream": {
      "enabled": true,
      "llmEnabled": true,
      "batchLimit": 50,
      "sinceLastRun": true,
      "project": "default",
      "provider": "mock"
    }
  }
}
```

- `sinceLastRun: true` — only experiments after `lastDreamAt`
- `llmEnabled: false` — run A+B only
- `provider` — key in `providers` for track C (falls back to first `mock`)

## MCP

```text
llm_dream_run
  dryRun?: boolean
  llmEnabled?: boolean
  sinceLastRun?: boolean
  batchLimit?: number
```

## Related

- [`memory-dream-roadmap.md`](memory-dream-roadmap.md)
- [`memory-production.md`](memory-production.md)
