/**
 * Event-log replay for audit / regression (Phase 7.6).
 */

import type { EventLog, EventLogEntry } from "./event-log.js";
import type { OrchestrationEvent } from "./multi-agent-types.js";
import type {
  ApprovalTraceRecord,
  HandoffTraceRecord,
  OrchestrationTraceRecord,
  PipelineTrace,
} from "../observability/trace.js";

export interface ReplaySummary {
  runId: string;
  eventCount: number;
  stepStarted: number;
  stepFinished: number;
  handoffs: number;
  agentRegistered: number;
}

export function eventToTraceRecord(entry: EventLogEntry): OrchestrationTraceRecord {
  const e = entry.event;
  return {
    seq: entry.seq,
    timestamp: entry.timestamp,
    type: e.type,
    detail: eventToDetail(e),
  };
}

function eventToDetail(event: OrchestrationEvent): Record<string, unknown> {
  switch (event.type) {
    case "agent_registered":
      return { agentId: event.agentId, role: event.role };
    case "agent_disposed":
      return { agentId: event.agentId };
    case "step_started":
      return { agentId: event.agentId, stepId: event.stepId };
    case "step_finished":
      return {
        agentId: event.agentId,
        stepId: event.stepId,
        ok: event.ok,
        durationMs: event.durationMs,
      };
    case "graph_patched":
      return { patchId: event.patchId, summary: event.summary };
    case "handoff":
      return { from: event.from, to: event.to, reason: event.reason };
    case "knowledge_shared":
      return { from: event.from, to: event.to, keys: event.keys };
    case "plan_created":
      return { agentId: event.agentId, steps: event.steps };
    case "plan_revision":
      return { agentId: event.agentId, steps: event.steps, trigger: event.trigger };
    case "approval_requested":
      return {
        requestId: event.requestId,
        agentId: event.agentId,
        action: event.action,
        phase: event.phase,
        description: event.description,
        requestedAt: event.requestedAt,
      };
    case "approval_resolved":
      return {
        requestId: event.requestId,
        agentId: event.agentId,
        action: event.action,
        phase: event.phase,
        decision: event.decision,
        respondedAt: event.respondedAt,
        respondedBy: event.respondedBy,
        reason: event.reason,
      };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

export function extractApprovalsFromEventLog(entries: EventLogEntry[]): ApprovalTraceRecord[] {
  const requested = new Map<string, ApprovalTraceRecord>();
  const resolved: ApprovalTraceRecord[] = [];

  for (const entry of entries) {
    if (entry.event.type === "approval_requested") {
      const ev = entry.event;
      requested.set(ev.requestId, {
        requestId: ev.requestId,
        agentId: ev.agentId,
        action: ev.action,
        phase: ev.phase,
        requestedAt: ev.requestedAt,
        decision: "pending",
        respondedAt: entry.timestamp,
      });
    }
    if (entry.event.type === "approval_resolved") {
      const ev = entry.event;
      resolved.push({
        requestId: ev.requestId,
        agentId: ev.agentId,
        action: ev.action,
        phase: ev.phase,
        requestedAt: requested.get(ev.requestId)?.requestedAt,
        decision: ev.decision,
        respondedAt: ev.respondedAt,
        respondedBy: ev.respondedBy,
        reason: ev.reason,
      });
      requested.delete(ev.requestId);
    }
  }

  return [...resolved, ...requested.values()];
}

function mergeApprovalTraces(
  fromLog: ApprovalTraceRecord[],
  explicit?: ApprovalTraceRecord[],
): ApprovalTraceRecord[] {
  const byId = new Map<string, ApprovalTraceRecord>();
  for (const a of fromLog) byId.set(a.requestId, a);
  for (const a of explicit ?? []) {
    const prev = byId.get(a.requestId);
    byId.set(a.requestId, prev ? { ...prev, ...a } : a);
  }
  return [...byId.values()].sort((a, b) => a.respondedAt - b.respondedAt);
}

export function extractHandoffs(entries: EventLogEntry[]): HandoffTraceRecord[] {
  return entries
    .filter((e) => e.event.type === "handoff")
    .map((e) => {
      const ev = e.event as Extract<OrchestrationEvent, { type: "handoff" }>;
      return {
        from: ev.from,
        to: ev.to,
        reason: ev.reason,
        timestamp: e.timestamp,
        seq: e.seq,
      };
    });
}

export function replayRunFromEventLog(eventLog: EventLog, runId: string): {
  records: OrchestrationTraceRecord[];
  handoffs: HandoffTraceRecord[];
  summary: ReplaySummary;
} {
  const entries = eventLog.replay(runId);
  const records = entries.map(eventToTraceRecord);
  const handoffs = extractHandoffs(entries);

  let stepStarted = 0;
  let stepFinished = 0;
  let agentRegistered = 0;
  for (const e of entries) {
    if (e.event.type === "step_started") stepStarted++;
    if (e.event.type === "step_finished") stepFinished++;
    if (e.event.type === "agent_registered") agentRegistered++;
  }

  return {
    records,
    handoffs,
    summary: {
      runId,
      eventCount: entries.length,
      stepStarted,
      stepFinished,
      handoffs: handoffs.length,
      agentRegistered,
    },
  };
}

export function enrichTraceWithEventLog(
  trace: PipelineTrace,
  eventLog: EventLog,
  runId: string,
  approvals?: ApprovalTraceRecord[],
): PipelineTrace {
  const entries = eventLog.replay(runId);
  const { records, handoffs } = replayRunFromEventLog(eventLog, runId);
  const fromLog = extractApprovalsFromEventLog(entries);
  return {
    ...trace,
    orchestrationEvents: records,
    handoffs,
    approvals: mergeApprovalTraces(fromLog, approvals ?? trace.approvals),
  };
}
