import assert from "node:assert/strict";
import test from "node:test";
import { agentId, type AgentDescriptor, type OrchestrationEvent, type AgentRole } from "../../src/orchestration/multi-agent-types.ts";
import { AgentState } from "../../src/orchestration/agent-state.ts";
import { AgentRegistry } from "../../src/orchestration/registry.ts";
import type { AgentConfig, AgentTask, AgentResult, AgentInstance } from "../../src/orchestration/agent.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../src/providers/types.ts";

// --- Helpers ---

function mockProvider(name: string): LLMProvider {
  return {
    name,
    mode: "text",
    async execute(_req: LLMRequest): Promise<LLMResponse> {
      return {
        kind: "text",
        content: `response from ${name}`,
        code: "",
        explanation: "",
        model: "mock",
        insights: { hint: "test-insight" },
      };
    },
  };
}

function makeConfig(id: string, role: AgentRole = "worker"): AgentConfig {
  return {
    id: agentId(id),
    role,
    providerName: `provider-${id}`,
    capabilities: role === "reviewer" ? ["review", "verify"] : ["implement"],
  };
}

// --- agentId ---

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

// --- AgentState ---

test("AgentState: knowledge merge and retrieval", () => {
  const state = new AgentState(agentId("s1"));
  state.mergeKnowledge({ a: "1", b: "2" });
  state.mergeKnowledge({ b: "3", c: "4" });
  assert.equal(state.getKnowledgeValue("a"), "1");
  assert.equal(state.getKnowledgeValue("b"), "3"); // overwritten
  assert.equal(state.getKnowledgeValue("c"), "4");
  assert.equal(state.getKnowledgeValue("missing"), undefined);
});

test("AgentState: execution history tracking", () => {
  const state = new AgentState(agentId("s2"));
  assert.equal(state.getLastExecution(), undefined);

  state.recordExecution({ stepName: "gen", round: 1, durationMs: 100, success: true, timestamp: 1000 });
  state.recordExecution({ stepName: "review", round: 1, durationMs: 200, success: false, timestamp: 2000 });

  assert.equal(state.getExecutionHistory().length, 2);
  assert.equal(state.getLastExecution()?.stepName, "review");
  assert.equal(state.getLastExecution()?.success, false);
});

test("AgentState: candidateRef get/set", () => {
  const state = new AgentState(agentId("s3"));
  assert.equal(state.getCandidateRef(), undefined);
  state.setCandidateRef("abc123");
  assert.equal(state.getCandidateRef(), "abc123");
  state.setCandidateRef(undefined);
  assert.equal(state.getCandidateRef(), undefined);
});

test("AgentState: snapshot and restore", () => {
  const state = new AgentState(agentId("s4"));
  state.mergeKnowledge({ key: "val" });
  state.setCandidateRef("ref1");
  state.recordExecution({ stepName: "gen", round: 1, durationMs: 50, success: true, timestamp: 500 });

  const snap = state.snapshot();
  assert.equal(snap.id, "s4");
  assert.deepEqual(snap.knowledge, { key: "val" });
  assert.equal(snap.candidateRef, "ref1");
  assert.equal(snap.executionHistory.length, 1);

  const restored = AgentState.fromSnapshot(snap);
  assert.equal(restored.id, "s4");
  assert.equal(restored.getKnowledgeValue("key"), "val");
  assert.equal(restored.getCandidateRef(), "ref1");
  assert.equal(restored.getExecutionHistory().length, 1);
});

test("AgentState: reset clears everything", () => {
  const state = new AgentState(agentId("s5"));
  state.mergeKnowledge({ a: "1" });
  state.setCandidateRef("ref");
  state.recordExecution({ stepName: "x", round: 1, durationMs: 10, success: true, timestamp: 0 });
  state.reset();

  assert.equal(state.getKnowledgeValue("a"), undefined);
  assert.equal(state.getCandidateRef(), undefined);
  assert.equal(state.getExecutionHistory().length, 0);
});

// --- AgentRegistry ---

test("AgentRegistry: register and lookup by id", () => {
  const reg = new AgentRegistry();
  const config = makeConfig("agent-a");
  const agent = reg.register(config, mockProvider("p-a"));

  assert.equal(agent.id, "agent-a");
  assert.equal(agent.role, "worker");
  assert.equal(reg.size, 1);
  assert.equal(reg.get(agentId("agent-a")), agent);
  assert.equal(reg.getOrThrow(agentId("agent-a")), agent);
  reg.disposeAll();
});

test("AgentRegistry: duplicate registration throws", () => {
  const reg = new AgentRegistry();
  reg.register(makeConfig("dup"), mockProvider("p"));
  assert.throws(() => reg.register(makeConfig("dup"), mockProvider("p2")), /already registered/);
  reg.disposeAll();
});

test("AgentRegistry: getOrThrow on missing agent", () => {
  const reg = new AgentRegistry();
  assert.throws(() => reg.getOrThrow(agentId("nope")), /not found/);
});

test("AgentRegistry: findByRole", () => {
  const reg = new AgentRegistry();
  reg.register(makeConfig("w1", "worker"), mockProvider("p1"));
  reg.register(makeConfig("w2", "worker"), mockProvider("p2"));
  reg.register(makeConfig("r1", "reviewer"), mockProvider("p3"));

  assert.equal(reg.findByRole("worker").length, 2);
  assert.equal(reg.findByRole("reviewer").length, 1);
  assert.equal(reg.findByRole("orchestrator").length, 0);
  reg.disposeAll();
});

test("AgentRegistry: findByCapability", () => {
  const reg = new AgentRegistry();
  reg.register(makeConfig("w1", "worker"), mockProvider("p1"));
  reg.register(makeConfig("r1", "reviewer"), mockProvider("p2"));

  assert.equal(reg.findByCapability("implement").length, 1);
  assert.equal(reg.findByCapability("review").length, 1);
  assert.equal(reg.findByCapability("plan").length, 0);
  reg.disposeAll();
});

test("AgentRegistry: ids returns all registered ids", () => {
  const reg = new AgentRegistry();
  reg.register(makeConfig("a"), mockProvider("p1"));
  reg.register(makeConfig("b"), mockProvider("p2"));

  const ids = reg.ids();
  assert.equal(ids.length, 2);
  assert.ok(ids.includes(agentId("a")));
  assert.ok(ids.includes(agentId("b")));
  reg.disposeAll();
});

test("AgentRegistry: disposeAll clears registry", () => {
  const reg = new AgentRegistry();
  reg.register(makeConfig("x"), mockProvider("p"));
  assert.equal(reg.size, 1);
  reg.disposeAll();
  assert.equal(reg.size, 0);
  assert.equal(reg.get(agentId("x")), undefined);
});

// --- DefaultAgent (via registry) execute ---

test("DefaultAgent: execute calls provider and records state", async () => {
  const reg = new AgentRegistry();
  const agent = reg.register(makeConfig("exec-test"), mockProvider("mock-p"));

  const task: AgentTask = {
    stepName: "generate",
    prompt: "write code",
    round: 1,
    sessionId: "sess-1",
  };

  const result = await agent.execute(task);
  assert.equal(result.agentId, "exec-test");
  assert.equal(result.stepName, "generate");
  assert.equal(result.response.kind, "text");
  assert.ok(result.durationMs >= 0);
  assert.deepEqual(result.insights, { hint: "test-insight" });

  // State should be updated
  assert.equal(agent.state.getExecutionHistory().length, 1);
  assert.equal(agent.state.getLastExecution()?.stepName, "generate");
  assert.equal(agent.state.getLastExecution()?.success, true);
  assert.equal(agent.state.getKnowledgeValue("hint"), "test-insight");

  reg.disposeAll();
});

test("DefaultAgent: execute after dispose throws", async () => {
  const reg = new AgentRegistry();
  const agent = reg.register(makeConfig("disp"), mockProvider("p"));
  agent.dispose();

  const task: AgentTask = { stepName: "s", prompt: "p", round: 1, sessionId: "x" };
  await assert.rejects(() => agent.execute(task), /disposed/);
});

// --- Legacy adapter ---

test("AgentRegistry.legacyStepsToAgentConfigs converts pipeline steps", () => {
  const pipeline: Record<string, [string | string[], ...string[]]> = {
    generate: ["openai-pro"],
    review: ["openai-pro", "generate"],
    refine: ["openai-lite", "review"],
  };

  const configs = AgentRegistry.legacyStepsToAgentConfigs(pipeline, "review");
  assert.equal(configs.length, 3);

  const gen = configs.find((c) => c.id === "generate")!;
  assert.equal(gen.role, "worker");
  assert.ok(gen.capabilities.includes("implement"));

  const rev = configs.find((c) => c.id === "review")!;
  assert.equal(rev.role, "reviewer");
  assert.ok(rev.capabilities.includes("review"));
  assert.ok(rev.capabilities.includes("verify"));
});

test("AgentRegistry.fromConfigs creates registry from config array", () => {
  const configs = [makeConfig("a1"), makeConfig("a2", "reviewer")];
  const reg = AgentRegistry.fromConfigs(configs, (name) => mockProvider(name));

  assert.equal(reg.size, 2);
  assert.equal(reg.getOrThrow(agentId("a1")).role, "worker");
  assert.equal(reg.getOrThrow(agentId("a2")).role, "reviewer");
  reg.disposeAll();
});
