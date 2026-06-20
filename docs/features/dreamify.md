# Dreamify (M3)

> **Experimental / offline.** Tuning runs are manual or MCP-triggered; best-params format may change.

Offline grid search for **pattern retrieval** hyperparameters, scored against `experiments.jsonl` + traces + experiment summary reports.

Does not run during pipeline execution. Results are persisted and read on the next run via `resolveDreamifyRetrieval()`.

## Search space (default grid)

| Parameter | Values |
|-----------|--------|
| `minSemanticSimilarity` | 0.25, 0.35, 0.45 |
| `patternLimit` | 2, 3, 5 |
| `decayHalfLifeDays` | 3, 7, 14 |
| `fileLinkMinOverlap` | 1, 2 |

54 combinations; objective blends approved hit rate, failed abstention, token efficiency, and winner-variant alignment.

## Artifacts

| Path | Purpose |
|------|---------|
| `~/.runoff/dreamify/best-params.json` | Active params + `previous` for rollback |
| `~/.runoff/dreamify/history/*.json` | Snapshot per tune run |

## Config

```json
{
  "orchestration": {
    "dreamify": {
      "experimentId": "<prompt-hash experiment id>",
      "project": "default"
    }
  }
}
```

## MCP

```text
runoff_dreamify_tune { "experimentId": "abc123...", "dryRun": false }
```

`dryRun: true` — score grid only, no file write.

## Hot path

After a successful tune, `PatternCache` and semantic memory ranking use `best-params.json` automatically.

## M4 options

```json
{
  "orchestration": {
    "dreamify": {
      "multiStrategy": true,
      "exportOnDreamRun": true
    }
  }
}
```

- `multiStrategy` — fuse semantic + BM25-lite + entity graph hop (`dreamify-multi-retrieve.ts`)
- `exportOnDreamRun` — after `runoff_dream_run`, write `dream-export.jsonl`

Manual export: `runoff_dream_export`.

`runoff_show_config` includes a `dreamify` block with **active** params and persisted tune file.

## Related

- [`dream.md`](features/dream.md) — Dream worker (M2)
- [`observability-eval.md`](features/observability-eval.md) — experiment reports
