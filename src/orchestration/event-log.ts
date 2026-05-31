/**
 * Event Log (Wave 7.2).
 *
 * Append-only event log for orchestration events.
 * Supports replay, audit, and recovery. In-memory for dev;
 * production must use a durable adapter.
 */

import type { OrchestrationEvent } from "./multi-agent-types.js";
import { enrichEventLogEntry } from "./event-log-span.js";

// --- Log Entry ---

export interface EventLogEntry {
  /** Monotonically increasing sequence number. */
  seq: number;
  /** Timestamp of the event. */
  timestamp: number;
  /** Run id this event belongs to. */
  runId: string;
  /** The event payload. */
  event: OrchestrationEvent;
  /** OTel span id (Phase 8.3.9, from step_started/step_finished). */
  spanId?: string;
  parentSpanId?: string;
}

// --- Query ---

export interface EventLogQuery {
  runId?: string;
  eventType?: OrchestrationEvent["type"];
  /** Inclusive lower bound on seq. */
  afterSeq?: number;
  /** Inclusive lower bound on timestamp. */
  since?: number;
  limit?: number;
}

// --- Event Log Interface ---

export interface EventLog {
  /** Append an event. Returns the assigned sequence number. */
  append(runId: string, event: OrchestrationEvent): number;

  /** Query events. */
  query(q: EventLogQuery): EventLogEntry[];

  /** Get all events for a run in order (for replay). */
  replay(runId: string, afterSeq?: number): EventLogEntry[];

  /** Total events in the log. */
  readonly length: number;

  /** Clear all events. */
  clear(): void;
}

// --- In-Memory Implementation ---

export class InMemoryEventLog implements EventLog {
  private entries: EventLogEntry[] = [];
  private nextSeq = 1;

  append(runId: string, event: OrchestrationEvent): number {
    const seq = this.nextSeq++;
    this.entries.push(enrichEventLogEntry(seq, Date.now(), runId, event));
    return seq;
  }

  query(q: EventLogQuery): EventLogEntry[] {
    let results = this.entries;

    if (q.runId) results = results.filter((e) => e.runId === q.runId);
    if (q.eventType) results = results.filter((e) => e.event.type === q.eventType);
    if (q.afterSeq !== undefined) results = results.filter((e) => e.seq >= q.afterSeq!);
    if (q.since !== undefined) results = results.filter((e) => e.timestamp >= q.since!);
    if (q.limit) results = results.slice(0, q.limit);

    return results;
  }

  replay(runId: string, afterSeq?: number): EventLogEntry[] {
    return this.entries.filter(
      (e) => e.runId === runId && (afterSeq === undefined || e.seq > afterSeq)
    );
  }

  get length(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
    this.nextSeq = 1;
  }
}
