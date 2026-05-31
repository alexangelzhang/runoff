import assert from "node:assert/strict";
import test from "node:test";
import { agentId } from "../src/orchestration/multi-agent-types.ts";
import { InMemoryEventLog } from "../src/orchestration/event-log.ts";
import { ApprovalManager } from "../src/orchestration/approval.ts";
import { AutoApprovalGate } from "../src/orchestration/approval.ts";
import { createApprovalAuditSink } from "../src/orchestration/approval-audit.ts";
import {
  enrichTraceWithEventLog,
  extractApprovalsFromEventLog,
} from "../src/orchestration/replay.ts";
import type { PipelineTrace } from "../src/observability/trace.ts";

test("approval audit emits requested and resolved to event log", async () => {
  const log = new InMemoryEventLog();
  const runId = "run-audit";
  const sink = createApprovalAuditSink(log, runId);
  const manager = new ApprovalManager(new AutoApprovalGate("low"), {
    onRequested: (req) => sink.emitRequested(req, "action"),
    onRecord: (record) => sink.emitResolved(record, "action", "test"),
  });

  await manager.requestApproval(
    { agentId: agentId("worker"), action: "execute_step", risk: "low" },
    "run step",
  );

  const entries = log.replay(runId);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.event.type, "approval_requested");
  assert.equal(entries[1]!.event.type, "approval_resolved");

  const approvals = extractApprovalsFromEventLog(entries);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.decision, "approve");
  assert.equal(approvals[0]!.respondedBy, "test");
});

test("enrichTraceWithEventLog merges approvals from event log", () => {
  const log = new InMemoryEventLog();
  const runId = "t-merge";
  const oid = agentId("orchestrator");
  log.append(runId, {
    type: "approval_requested",
    requestId: "a1",
    agentId: oid,
    action: "execute_plan",
    phase: "plan",
    description: "plan",
    requestedAt: 1000,
  });
  log.append(runId, {
    type: "approval_resolved",
    requestId: "a1",
    agentId: oid,
    action: "execute_plan",
    phase: "plan",
    decision: "approve",
    respondedAt: 2000,
    respondedBy: "operator",
  });

  const base: PipelineTrace = {
    id: runId,
    prompt: "p",
    promptLength: 1,
    mode: "pipeline",
    steps: [],
    totalRounds: 0,
    finalStatus: "approved",
    totalDurationMs: 100,
    hasVerifyResults: false,
    timestamp: new Date().toISOString(),
  };

  const enriched = enrichTraceWithEventLog(base, log, runId);
  assert.equal(enriched.approvals?.length, 1);
  assert.equal(enriched.approvals?.[0]?.phase, "plan");
  assert.equal(enriched.approvals?.[0]?.respondedBy, "operator");
});
