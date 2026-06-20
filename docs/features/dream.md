# Dream Worker (M2)

> **Experimental / offline.** Not on the hot pipeline path. APIs and artifact layout may change without semver notice.

Offline memory **Evolution** pass: structure traces (A) → rule updates (B) → optional LLM enrich (C).

Not run on the hot pipeline path. Trigger via MCP `runoff_dream_run` or import `runDreamWorker`.

## Tracks

| Track | Module | Description |
|-------|--------|-------------|
| **A** | `dream-structured.ts` | Deterministic `DreamBatchItem` from `experiments.jsonl` + trace files |
| **B** | `dream-rules.ts` | ADD/UPDATE patterns, LESSON on failure, CONTRADICT patterns, FEEDBACK relevance, FORGET decay/TTL, **B7** globalKnowledge→lesson (opt-in) |
| **C** | `dream-llm.ts` | Optional LLM proposals (`lesson`, `trace_summary`) via `dream-enrich` step |

## Artifacts

| Path | Purpose |
|------|---------|
| `~/.runoff/dream-state.json` | `lastDreamAt` cursor |
| `~/.runoff/dream-audit.jsonl` | One JSON line per rule/audit action |
| `~/.runoff/memory/` | Local memory (source of truth) |

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
      "provider": "mock",
      "promoteGlobalKnowledge": false,
      "globalKnowledgeMinLength": 24
    }
  }
}
```

- `sinceLastRun: true` — only experiments after `lastDreamAt`
- `llmEnabled: false` — run A+B only
- `promoteGlobalKnowledge: true` — on **approved** runs, promote trace `globalKnowledge` insights to `lesson` entries (rule B7; requires trace persistence from pipeline end)
- `globalKnowledgeMinLength` — skip short insight values (default 24)
- `provider` — key in `providers` for track C (falls back to first `mock`)

## MCP

```text
runoff_dream_run
  dryRun?: boolean
  llmEnabled?: boolean
  sinceLastRun?: boolean
  batchLimit?: number
```

## Related

- [`memory-dream-roadmap.md`](features/memory-dream-roadmap.md)
- [`memory-production.md`](features/memory-production.md)
