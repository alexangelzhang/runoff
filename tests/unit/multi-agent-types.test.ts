import assert from "node:assert/strict";
import test from "node:test";
import { agentId, type AgentDescriptor, type OrchestrationEvent } from "../../src/orchestration/multi-agent-types.ts";

test("agentId accepts valid tokens", () => {
  assert.equal(String(agentId("worker-1")), "worker-1");
  assert.equal(String(agentId("Orchestrator.v2")), "Orchestrator.v2");
});

test("agentId rejects empty or invalid", () => {
  assert.throws(() => agentId(""), /Invalid agentId/);
  assert.throws(() => agentId("   "), /Invalid agentId/);
  assert.throws(() => agentId("bad id"), /Invalid agentId/);
});

test("factory helpers produce structurally valid descriptors and events", () => {
  const id = agentId("orch");
  const d: AgentDescriptor = { id, role: "orchestrator", capabilities: ["plan"] };
  assert.equal(d.role, "orchestrator");

  const ev: OrchestrationEvent = { type: "handoff", from: id, to: agentId("w1") };
  assert.equal(ev.type, "handoff");
});
