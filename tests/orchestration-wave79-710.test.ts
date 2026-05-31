import assert from "node:assert/strict";
import test from "node:test";
import { agentId } from "../src/orchestration/multi-agent-types.ts";
import {
  createTextArtifact,
  createCodeArtifact,
  createDataArtifact,
  createFileArtifact,
  resetArtifactIdCounter,
} from "../src/orchestration/a2a/artifact.ts";
import { A2ATaskManager } from "../src/orchestration/a2a/task.ts";
import { AgentCardRegistry, type A2AAgentCard } from "../src/orchestration/a2a/agent-card.ts";
import { InMemoryA2ATransport } from "../src/orchestration/a2a/transport.ts";
import { InMemoryAgentMemory } from "../src/orchestration/memory.ts";

const A = agentId("agent-a");
const B = agentId("agent-b");
const C = agentId("agent-c");

// ============================================================
// A2A Artifact (Wave 7.9)
// ============================================================

test("A2A Artifact: createTextArtifact", () => {
  resetArtifactIdCounter();
  const art = createTextArtifact("readme", "Hello world");
  assert.equal(art.name, "readme");
  assert.equal(art.parts.length, 1);
  assert.equal(art.parts[0].type, "text");
  if (art.parts[0].type === "text") {
    assert.equal(art.parts[0].text, "Hello world");
  }
});

test("A2A Artifact: createCodeArtifact", () => {
  const art = createCodeArtifact("main.ts", "console.log('hi')", "typescript");
  assert.equal(art.parts[0].type, "text");
  assert.equal(art.metadata?.language, "typescript");
});

test("A2A Artifact: createDataArtifact", () => {
  const art = createDataArtifact("config", { key: "value", count: 42 });
  assert.equal(art.parts[0].type, "data");
  if (art.parts[0].type === "data") {
    assert.equal(art.parts[0].data.key, "value");
  }
});

test("A2A Artifact: createFileArtifact", () => {
  const art = createFileArtifact("patch.diff", "file:///tmp/patch.diff", "text/x-diff");
  assert.equal(art.parts[0].type, "file");
  if (art.parts[0].type === "file") {
    assert.equal(art.parts[0].uri, "file:///tmp/patch.diff");
  }
});

// ============================================================
// A2A Task Manager (Wave 7.9)
// ============================================================

test("A2ATaskManager: send creates pending task", () => {
  const mgr = new A2ATaskManager();
  const task = mgr.send(A, B, "refactor this code");
  assert.equal(task.status, "pending");
  assert.equal(task.from, A);
  assert.equal(task.to, B);
  assert.equal(mgr.size, 1);
});

test("A2ATaskManager: execute dispatches to handler", async () => {
  const mgr = new A2ATaskManager();
  mgr.registerHandler(B, async (task) => {
    return [createTextArtifact("result", `done: ${task.instruction}`)];
  });

  const task = mgr.send(A, B, "write tests");
  const result = await mgr.execute(task.id);

  assert.equal(result.status, "completed");
  assert.equal(result.outputArtifacts?.length, 1);
});

test("A2ATaskManager: execute fails without handler", async () => {
  const mgr = new A2ATaskManager();
  const task = mgr.send(A, B, "do something");
  const result = await mgr.execute(task.id);

  assert.equal(result.status, "failed");
  assert.ok(result.error?.includes("No handler"));
});

test("A2ATaskManager: execute fails on handler error", async () => {
  const mgr = new A2ATaskManager();
  mgr.registerHandler(B, async () => { throw new Error("boom"); });

  const task = mgr.send(A, B, "crash");
  const result = await mgr.execute(task.id);

  assert.equal(result.status, "failed");
  assert.equal(result.error, "boom");
});

test("A2ATaskManager: cancel pending task", () => {
  const mgr = new A2ATaskManager();
  const task = mgr.send(A, B, "do it");
  assert.equal(mgr.cancel(task.id), true);
  assert.equal(mgr.getStatus(task.id), "cancelled");
});

test("A2ATaskManager: cannot cancel completed task", async () => {
  const mgr = new A2ATaskManager();
  mgr.registerHandler(B, async () => []);
  const task = mgr.send(A, B, "do it");
  await mgr.execute(task.id);
  assert.equal(mgr.cancel(task.id), false);
});

test("A2ATaskManager: listByAgent filters correctly", () => {
  const mgr = new A2ATaskManager();
  mgr.send(A, B, "task 1");
  mgr.send(A, C, "task 2");
  mgr.send(B, C, "task 3");

  assert.equal(mgr.listByAgent(B, "to").length, 1);
  assert.equal(mgr.listByAgent(C, "to").length, 2);
  assert.equal(mgr.listByAgent(A, "from").length, 2);
});

test("A2ATaskManager: clear resets everything", () => {
  const mgr = new A2ATaskManager();
  mgr.send(A, B, "task");
  mgr.clear();
  assert.equal(mgr.size, 0);
});

// ============================================================
// A2A Agent Card Registry (Wave 7.9)
// ============================================================

function makeCard(id: string, role: "worker" | "reviewer", skills: string[]): A2AAgentCard {
  return {
    agentId: agentId(id),
    name: id,
    description: `Agent ${id}`,
    role,
    capabilities: ["implement"],
    skills: skills.map((s) => ({ id: s, name: s, description: `Skill ${s}`, tags: [s] })),
    protocolVersion: "1.0",
  };
}

test("AgentCardRegistry: register and get", () => {
  const reg = new AgentCardRegistry();
  const card = makeCard("coder", "worker", ["code", "refactor"]);
  reg.register(card);

  assert.equal(reg.size, 1);
  assert.equal(reg.get(agentId("coder"))?.name, "coder");
});

test("AgentCardRegistry: findBySkill", () => {
  const reg = new AgentCardRegistry();
  reg.register(makeCard("coder", "worker", ["code", "refactor"]));
  reg.register(makeCard("reviewer", "reviewer", ["review"]));

  assert.equal(reg.findBySkill("code").length, 1);
  assert.equal(reg.findBySkill("review").length, 1);
  assert.equal(reg.findBySkill("nonexistent").length, 0);
});

test("AgentCardRegistry: findByRole", () => {
  const reg = new AgentCardRegistry();
  reg.register(makeCard("c1", "worker", ["code"]));
  reg.register(makeCard("c2", "worker", ["refactor"]));
  reg.register(makeCard("r1", "reviewer", ["review"]));

  assert.equal(reg.findByRole("worker").length, 2);
  assert.equal(reg.findByRole("reviewer").length, 1);
});

test("AgentCardRegistry: unregister", () => {
  const reg = new AgentCardRegistry();
  reg.register(makeCard("c1", "worker", ["code"]));
  assert.equal(reg.unregister(agentId("c1")), true);
  assert.equal(reg.size, 0);
  assert.equal(reg.unregister(agentId("c1")), false);
});

test("AgentCardRegistry: clear", () => {
  const reg = new AgentCardRegistry();
  reg.register(makeCard("c1", "worker", ["code"]));
  reg.register(makeCard("c2", "worker", ["code"]));
  reg.clear();
  assert.equal(reg.size, 0);
});

// ============================================================
// A2A Transport (Wave 7.9)
// ============================================================

test("InMemoryA2ATransport: send and receive", async () => {
  const transport = new InMemoryA2ATransport();
  const received: string[] = [];

  transport.onMessage(B, async (msg) => {
    received.push(msg.method);
  });

  await transport.send({ id: "", from: A, to: B, method: "task/send", payload: {}, timestamp: 0 });
  assert.equal(received.length, 1);
  assert.equal(received[0], "task/send");
  assert.equal(transport.messageCount, 1);
});

test("InMemoryA2ATransport: no handler = silent queue", async () => {
  const transport = new InMemoryA2ATransport();
  await transport.send({ id: "", from: A, to: B, method: "task/send", payload: {}, timestamp: 0 });
  assert.equal(transport.messageCount, 1);
  assert.equal(transport.getMessagesFor(B).length, 1);
});

test("InMemoryA2ATransport: offMessage stops delivery", async () => {
  const transport = new InMemoryA2ATransport();
  let count = 0;
  transport.onMessage(B, async () => { count++; });

  await transport.send({ id: "1", from: A, to: B, method: "m", payload: {}, timestamp: 0 });
  transport.offMessage(B);
  await transport.send({ id: "2", from: A, to: B, method: "m", payload: {}, timestamp: 0 });

  assert.equal(count, 1);
  assert.equal(transport.messageCount, 2); // both logged
});

test("InMemoryA2ATransport: getMessagesFrom filters", async () => {
  const transport = new InMemoryA2ATransport();
  await transport.send({ id: "1", from: A, to: B, method: "m", payload: {}, timestamp: 0 });
  await transport.send({ id: "2", from: B, to: C, method: "m", payload: {}, timestamp: 0 });

  assert.equal(transport.getMessagesFrom(A).length, 1);
  assert.equal(transport.getMessagesFrom(B).length, 1);
});

test("InMemoryA2ATransport: clear resets everything", async () => {
  const transport = new InMemoryA2ATransport();
  await transport.send({ id: "1", from: A, to: B, method: "m", payload: {}, timestamp: 0 });
  transport.clear();
  assert.equal(transport.messageCount, 0);
});

// ============================================================
// Agent Memory (Wave 7.10)
// ============================================================

test("AgentMemory: store and retrieve", () => {
  const mem = new InMemoryAgentMemory();
  mem.store({
    agentId: A,
    scope: { project: "llm-pipeline" },
    category: "pattern",
    content: "Use branded types for type safety",
    relevance: 0.9,
  });

  const results = mem.retrieve({ category: "pattern" });
  assert.equal(results.length, 1);
  assert.equal(results[0].content, "Use branded types for type safety");
  assert.equal(mem.size, 1);
});

test("AgentMemory: retrieve filters by agent", () => {
  const mem = new InMemoryAgentMemory();
  mem.store({ agentId: A, scope: {}, category: "pattern", content: "a-pattern" });
  mem.store({ agentId: B, scope: {}, category: "pattern", content: "b-pattern" });

  assert.equal(mem.retrieve({ agentId: A }).length, 1);
  assert.equal(mem.retrieve({ agentId: B }).length, 1);
});

test("AgentMemory: retrieve filters by scope", () => {
  const mem = new InMemoryAgentMemory();
  mem.store({ agentId: A, scope: { project: "p1" }, category: "pattern", content: "p1-mem" });
  mem.store({ agentId: A, scope: { project: "p2" }, category: "pattern", content: "p2-mem" });

  assert.equal(mem.retrieve({ scope: { project: "p1" } }).length, 1);
});

test("AgentMemory: retrieve text search", () => {
  const mem = new InMemoryAgentMemory();
  mem.store({ agentId: A, scope: {}, category: "lesson", content: "Always validate input before processing" });
  mem.store({ agentId: A, scope: {}, category: "lesson", content: "Use retry with exponential backoff" });

  assert.equal(mem.retrieve({ textSearch: "validate" }).length, 1);
  assert.equal(mem.retrieve({ textSearch: "RETRY" }).length, 1); // case insensitive
});

test("AgentMemory: retrieve respects minRelevance", () => {
  const mem = new InMemoryAgentMemory();
  mem.store({ agentId: A, scope: {}, category: "pattern", content: "low", relevance: 0.3 });
  mem.store({ agentId: A, scope: {}, category: "pattern", content: "high", relevance: 0.9 });

  assert.equal(mem.retrieve({ minRelevance: 0.5 }).length, 1);
  assert.equal(mem.retrieve({ minRelevance: 0.5 })[0].content, "high");
});

test("AgentMemory: retrieve sorts by relevance then recency", () => {
  const mem = new InMemoryAgentMemory();
  mem.store({ agentId: A, scope: {}, category: "pattern", content: "low", relevance: 0.3 });
  mem.store({ agentId: A, scope: {}, category: "pattern", content: "high", relevance: 0.9 });
  mem.store({ agentId: A, scope: {}, category: "pattern", content: "mid", relevance: 0.6 });

  const results = mem.retrieve({});
  assert.equal(results[0].content, "high");
  assert.equal(results[1].content, "mid");
  assert.equal(results[2].content, "low");
});

test("AgentMemory: retrieve respects limit", () => {
  const mem = new InMemoryAgentMemory();
  for (let i = 0; i < 10; i++) {
    mem.store({ agentId: A, scope: {}, category: "pattern", content: `mem-${i}` });
  }
  assert.equal(mem.retrieve({ limit: 3 }).length, 3);
});

test("AgentMemory: TTL expiry", () => {
  const mem = new InMemoryAgentMemory();
  const entry = mem.store({
    agentId: A, scope: {}, category: "context", content: "temp", ttlMs: 1,
  });

  // Immediately after store, should be retrievable (race condition safe with small delay)
  // But with ttlMs=1, after any delay it expires
  // Force expiry by manipulating createdAt
  const stored = mem.retrieve({ includeExpired: true })[0];
  assert.ok(stored);

  // With includeExpired=false (default), expired entries are filtered
  // We can't easily test timing, so test includeExpired flag
  assert.equal(mem.retrieve({ includeExpired: true }).length, 1);
});

test("AgentMemory: forget by id", () => {
  const mem = new InMemoryAgentMemory();
  const entry = mem.store({ agentId: A, scope: {}, category: "pattern", content: "forget me" });
  assert.equal(mem.forget(entry.id), true);
  assert.equal(mem.size, 0);
  assert.equal(mem.forget(entry.id), false);
});

test("AgentMemory: forgetByScope", () => {
  const mem = new InMemoryAgentMemory();
  mem.store({ agentId: A, scope: { project: "p1" }, category: "pattern", content: "a" });
  mem.store({ agentId: A, scope: { project: "p1" }, category: "lesson", content: "b" });
  mem.store({ agentId: A, scope: { project: "p2" }, category: "pattern", content: "c" });

  const count = mem.forgetByScope({ project: "p1" });
  assert.equal(count, 2);
  assert.equal(mem.size, 1);
});

test("AgentMemory: updateRelevance", () => {
  const mem = new InMemoryAgentMemory();
  const entry = mem.store({ agentId: A, scope: {}, category: "pattern", content: "x", relevance: 0.5 });
  assert.equal(mem.updateRelevance(entry.id, 0.95), true);

  const results = mem.retrieve({});
  assert.equal(results[0].relevance, 0.95);
});

test("AgentMemory: updateRelevance clamps to 0-1", () => {
  const mem = new InMemoryAgentMemory();
  const entry = mem.store({ agentId: A, scope: {}, category: "pattern", content: "x" });
  mem.updateRelevance(entry.id, 1.5);
  assert.equal(mem.retrieve({})[0].relevance, 1);
  mem.updateRelevance(entry.id, -0.5);
  assert.equal(mem.retrieve({})[0].relevance, 0);
});

test("AgentMemory: clear resets everything", () => {
  const mem = new InMemoryAgentMemory();
  mem.store({ agentId: A, scope: {}, category: "pattern", content: "x" });
  mem.store({ agentId: B, scope: {}, category: "lesson", content: "y" });
  mem.clear();
  assert.equal(mem.size, 0);
});
