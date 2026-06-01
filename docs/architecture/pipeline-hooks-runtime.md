# Pipeline Hooks — Runtime & Durable Event Log

## Control plane modes

| Mode | How to enable | Event log |
|------|----------------|-----------|
| **memory** | default | `InMemoryEventLog` (process-local) |
| **file** | `runtime.controlPlane: "file"` or `RUNOFF_CONTROL_PLANE=file` | `FileEventLog` → `~/.runoff/control-plane/events.jsonl` |

`PipelineHooks` uses the same `EventLog` instance as `createControlPlane()` when passed from `pipeline-mcp-run.ts`, so orchestration events survive restarts in **file** mode.

## External listeners (P2)

```typescript
const hooks = new PipelineHooks(config, traceId, controlPlane.eventLog);
const off = hooks.addEventListener((event, seq) => {
  console.log(seq, event.type);
});
// ... run pipeline ...
off();
```

Events mirror `OrchestrationEventEmitter` append order (`step_started`, `step_finished`, `agent_disposed`, …).

## Hook lifecycle

1. `onPipelineStart` — pattern-cache context, `step_started` for pipeline agent  
2. `onStepComplete` — per-step `estimateCost`, `step_finished`  
3. `onPipelineEnd` — experiment log, judge, pattern store, OTel, `costSummary`  
4. `onPipelineFailed` — same as end but skips baseline judge  

See [pipeline-hooks-design.md](../design/pipeline-hooks-design.md) for the full data flow.
