/**
 * Phase 8.3.9 — Denormalize spanId onto EventLogEntry from step events.
 */

import type { OrchestrationEvent } from "./multi-agent-types.js";
import type { EventLogEntry } from "./event-log.js";

export function spanFieldsFromEvent(
  event: OrchestrationEvent,
): { spanId?: string; parentSpanId?: string } {
  if (event.type === "step_started" || event.type === "step_finished") {
    return {
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
    };
  }
  return {};
}

export function enrichEventLogEntry(
  seq: number,
  timestamp: number,
  runId: string,
  event: OrchestrationEvent,
): EventLogEntry {
  return {
    seq,
    timestamp,
    runId,
    event,
    ...spanFieldsFromEvent(event),
  };
}
