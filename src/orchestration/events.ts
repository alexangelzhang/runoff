/**
 * Orchestration Event Emitter (Wave 7.6).
 *
 * Bridges agent lifecycle events to the EventLog and optional external listeners.
 * Provides a typed emit API that the orchestrator and agents use to record events.
 */

import type { AgentId, AgentRole, OrchestrationEvent } from "./multi-agent-types.js";
import type { EventLog } from "./event-log.js";

export type EventListener = (event: OrchestrationEvent, seq: number) => void;

export class OrchestrationEventEmitter {
  private log: EventLog;
  private runId: string;
  private listeners = new Set<EventListener>();

  constructor(log: EventLog, runId: string) {
    this.log = log;
    this.runId = runId;
  }

  /** Add an external listener (for UI, trace, logging). */
  addListener(listener: EventListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: EventListener): void {
    this.listeners.delete(listener);
  }

  private emit(event: OrchestrationEvent): number {
    const seq = this.log.append(this.runId, event);
    for (const l of this.listeners) l(event, seq);
    return seq;
  }

  // --- Typed emit methods ---

  agentRegistered(agentId: AgentId, role: AgentRole): number {
    return this.emit({ type: "agent_registered", agentId, role });
  }

  agentDisposed(agentId: AgentId): number {
    return this.emit({ type: "agent_disposed", agentId });
  }

  stepStarted(
    agentId: AgentId,
    stepId: string,
    span?: { spanId?: string; parentSpanId?: string },
  ): number {
    return this.emit({
      type: "step_started",
      agentId,
      stepId,
      spanId: span?.spanId,
      parentSpanId: span?.parentSpanId,
    });
  }

  stepFinished(
    agentId: AgentId,
    stepId: string,
    ok: boolean,
    durationMs?: number,
    span?: { spanId?: string; parentSpanId?: string },
  ): number {
    return this.emit({
      type: "step_finished",
      agentId,
      stepId,
      ok,
      durationMs,
      spanId: span?.spanId,
      parentSpanId: span?.parentSpanId,
    });
  }

  graphPatched(patchId: string, summary?: string): number {
    return this.emit({ type: "graph_patched", patchId, summary });
  }

  handoff(from: AgentId, to: AgentId, reason?: string): number {
    return this.emit({ type: "handoff", from, to, reason });
  }

  knowledgeShared(from: AgentId, to: AgentId, keys: string[]): number {
    return this.emit({ type: "knowledge_shared", from, to, keys });
  }

  planCreated(agentId: AgentId, steps: Array<string | string[]>): number {
    return this.emit({ type: "plan_created", agentId, steps });
  }

  planRevision(
    agentId: AgentId,
    steps: Array<string | string[]>,
    trigger: "review_revision" | "step_failure",
  ): number {
    return this.emit({ type: "plan_revision", agentId, steps, trigger });
  }

  approvalRequested(
    requestId: string,
    agentId: AgentId,
    action: string,
    phase: "plan" | "action",
    description: string,
    requestedAt: number,
    risk?: "low" | "medium" | "high",
  ): number {
    return this.emit({
      type: "approval_requested",
      requestId,
      agentId,
      action,
      phase,
      description,
      requestedAt,
      risk,
    });
  }

  approvalResolved(
    requestId: string,
    agentId: AgentId,
    action: string,
    phase: "plan" | "action",
    decision: string,
    respondedAt: number,
    respondedBy?: string,
    reason?: string,
  ): number {
    return this.emit({
      type: "approval_resolved",
      requestId,
      agentId,
      action,
      phase,
      decision,
      respondedAt,
      respondedBy,
      reason,
    });
  }
}
