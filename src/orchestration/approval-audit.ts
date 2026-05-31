/**
 * Approval audit — append-only event log + trace records (Phase 7.8 + 2.3).
 */

import type { EventLog } from "./event-log.js";
import type { ApprovalRecord, ApprovalRequest, ApprovalResponse, RiskLevel } from "./approval.js";
import type { AgentId } from "./multi-agent-types.js";
import type { OrchestrationEvent } from "./multi-agent-types.js";
import type { ApprovalTraceRecord } from "../observability/trace.js";

export type ApprovalPhase = "plan" | "action";

export interface ApprovalAuditSink {
  emitRequested(request: ApprovalRequest, phase: ApprovalPhase): void;
  emitResolved(record: ApprovalRecord, phase: ApprovalPhase, respondedBy?: string): void;
}

export function createApprovalAuditSink(eventLog: EventLog, runId: string): ApprovalAuditSink {
  const append = (event: OrchestrationEvent) => {
    try {
      eventLog.append(runId, event);
    } catch {
      // non-critical
    }
  };

  return {
    emitRequested(request, phase) {
      append({
        type: "approval_requested",
        requestId: request.id,
        agentId: request.agentId,
        action: request.action,
        phase,
        description: request.description,
        risk: request.risk,
        requestedAt: request.requestedAt,
      });
    },
    emitResolved(record, phase, respondedBy) {
      const decision = record.response.decision;
      append({
        type: "approval_resolved",
        requestId: record.request.id,
        agentId: record.request.agentId,
        action: record.request.action,
        phase,
        decision,
        respondedAt: record.respondedAt,
        respondedBy: respondedBy ?? record.respondedBy,
        reason: decision === "reject" ? record.response.reason : undefined,
      });
    },
  };
}

export function approvalRecordToTrace(
  record: ApprovalRecord,
  phase: ApprovalPhase,
): ApprovalTraceRecord {
  return {
    requestId: record.request.id,
    agentId: record.request.agentId,
    action: record.request.action,
    phase,
    requestedAt: record.request.requestedAt,
    decision: record.response.decision,
    respondedAt: record.respondedAt,
    respondedBy: record.respondedBy,
    reason: record.response.decision === "reject" ? record.response.reason : undefined,
  };
}

export function emitDeferredApprovalResolved(
  eventLog: EventLog,
  runId: string,
  input: {
    requestId: string;
    agentId: AgentId;
    action: string;
    phase: ApprovalPhase;
    response: ApprovalResponse;
    respondedBy?: string;
  },
): void {
  const respondedAt = Date.now();
  const sink = createApprovalAuditSink(eventLog, runId);
  sink.emitResolved(
    {
      request: {
        id: input.requestId,
        agentId: input.agentId,
        action: input.action,
        description: "",
        risk: "medium" as RiskLevel,
        requestedAt: respondedAt,
      },
      response: input.response,
      respondedAt,
      respondedBy: input.respondedBy,
    },
    input.phase,
    input.respondedBy,
  );
}

export function recordsToApprovalTrace(
  records: readonly ApprovalRecord[],
  phase: ApprovalPhase = "action",
): ApprovalTraceRecord[] {
  return records.map((r) => approvalRecordToTrace(r, phase));
}
