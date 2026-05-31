import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig, type PipelineConfig } from "../../src/core/config.ts";
import { buildAgentToolRegistry } from "../../src/orchestration/agent-tools.ts";
import { AgentRegistry } from "../../src/orchestration/registry.ts";
import type { AgentConfig } from "../../src/orchestration/agent.ts";
import { agentId } from "../../src/orchestration/multi-agent-types.ts";
import { MockProvider } from "../../src/providers/mock.ts";

test("validateConfig accepts orchestration.useAgentTools", () => {
  const config: PipelineConfig = {
    providers: { mock: { type: "mock" } },
    pipeline: { gen: ["mock"] },
    orchestration: { mode: "dag", useAgentTools: true },
  };
  assert.equal(validateConfig(config), true);
});

test("buildAgentToolRegistry wires worker agents only", () => {
  const registry = new AgentRegistry();
  const cfg: AgentConfig = {
    id: agentId("gen"),
    role: "worker",
    providerName: "mock",
    capabilities: ["implement"],
  };
  registry.register(cfg, new MockProvider("mock"));
  const tools = buildAgentToolRegistry(registry, {
    gen: { role: "worker", provider: "mock" },
    lead: { role: "orchestrator", provider: "mock" },
  });
  assert.equal(tools.size, 1);
  assert.ok(tools.getToolDefinitions()[0]?.description.includes("worker"));
});
