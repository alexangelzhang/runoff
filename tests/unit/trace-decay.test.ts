import assert from "node:assert/strict";
import test from "node:test";
import { createStepSpanId, traceRecencyWeight } from "../../src/observability/trace.ts";
import { buildAgentToolRegistry } from "../../src/orchestration/agent-tools.ts";
import { AgentRegistry } from "../../src/orchestration/registry.ts";
import type { AgentConfig } from "../../src/orchestration/agent.ts";
import { agentId } from "../../src/orchestration/multi-agent-types.ts";
import { MockProvider } from "../../src/providers/mock.ts";

test("traceRecencyWeight: 7d/30d/older buckets", () => {
  const now = Date.parse("2026-05-26T12:00:00.000Z");
  assert.equal(traceRecencyWeight("2026-05-20T12:00:00.000Z", now), 1);
  assert.equal(traceRecencyWeight("2026-04-26T12:00:00.000Z", now), 0.5);
  assert.equal(traceRecencyWeight("2026-01-01T12:00:00.000Z", now), 0.1);
});

test("createStepSpanId returns 16 hex chars", () => {
  const id = createStepSpanId();
  assert.match(id, /^[0-9a-f]{16}$/);
});

test("buildAgentToolRegistry: skips orchestrator role", () => {
  const registry = new AgentRegistry();
  const cfg: AgentConfig = {
    id: agentId("implement"),
    role: "worker",
    providerName: "mock",
    capabilities: ["implement"],
  };
  registry.register(cfg, new MockProvider("mock"));
  const tools = buildAgentToolRegistry(registry, {
    orchestrator: { role: "orchestrator", provider: "mock" },
    implement: { role: "worker", provider: "mock", capabilities: ["implement"] },
  });
  assert.equal(tools.size, 1);
  assert.equal(tools.has("implement"), true);
});
