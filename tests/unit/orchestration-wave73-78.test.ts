import assert from "node:assert/strict";
import test from "node:test";
import { agentId } from "../../src/orchestration/multi-agent-types.ts";
import type { AgentInstance, AgentTask, AgentResult } from "../../src/orchestration/agent.ts";
import { AgentState } from "../../src/orchestration/agent-state.ts";
import type { LLMProvider, TextResponse } from "../../src/providers/types.ts";
import { SequentialAgent, ParallelAgent, LoopAgent } from "../../src/orchestration/workflow-agents.ts";
import { DAGOrchestrator, LLMOrchestrator, type OrchestrationContext } from "../../src/orchestration/orchestrator.ts";
import { AgentToolRegistry } from "../../src/orchestration/agent-tools.ts";
import {
  AutoApprovalGate,
  CallbackApprovalGate,
  ApprovalManager,
  type ApprovalRequest,
  type ApprovalResponse,
} from "../../src/orchestration/approval.ts";

const A = agentId("agent-a");
const B = agentId("agent-b");
const C = agentId("agent-c");

// --- Mock Agent ---

function makeTextResponse(content: string, failed = false): TextResponse {
  return { kind: "text", content, code: content, explanation: "", model: "mock", failed };
}

function createMockAgent(id: string, responseContent: string, delayMs = 0): AgentInstance {
  const aid = agentId(id);
  return {
    id: aid,
    role: "worker",
    capabilities: ["implement"],
    provider: { name: "mock", mode: "text", execute: async () => makeTextResponse(responseContent) } as LLMProvider,
    state: new AgentState(aid),
    async execute(task: AgentTask): Promise<AgentResult> {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return {
        agentId: aid,
        stepName: task.stepName,
        response: makeTextResponse(responseContent),
        durationMs: delayMs,
        insights: { [`${id}-insight`]: responseContent },
      };
    },
    dispose() {},
  };
}

// ============================================================
// SequentialAgent (Wave 7.3)
// ============================================================

test("SequentialAgent: executes children in order", async () => {
  const order: string[] = [];
  const child1 = createMockAgent("c1", "result-1");
  const origExec1 = child1.execute.bind(child1);
  child1.execute = async (t) => { order.push("c1"); return origExec1(t); };

  const child2 = createMockAgent("c2", "result-2");
  const origExec2 = child2.execute.bind(child2);
  child2.execute = async (t) => { order.push("c2"); return origExec2(t); };

  const seq = new SequentialAgent(A, [child1, child2]);
  const result = await seq.execute({
    stepName: "test", prompt: "do it", round: 1, sessionId: "s1",
  });

  assert.deepEqual(order, ["c1", "c2"]);
  assert.equal(result.agentId, A);
  assert.equal(result.response.kind, "text");
  if (result.response.kind === "text") {
    assert.equal(result.response.content, "result-2"); // last child's output
  }
});

test("SequentialAgent: chains output as reviewFeedback", async () => {
  let receivedFeedback = "";
  const child1 = createMockAgent("c1", "first-output");
  const child2 = createMockAgent("c2", "final");
  const origExec2 = child2.execute.bind(child2);
  child2.execute = async (t) => { receivedFeedback = t.reviewFeedback ?? ""; return origExec2(t); };

  const seq = new SequentialAgent(A, [child1, child2]);
  await seq.execute({ stepName: "test", prompt: "go", round: 1, sessionId: "s1" });

  assert.equal(receivedFeedback, "first-output");
});

test("SequentialAgent: merges insights from all children", async () => {
  const seq = new SequentialAgent(A, [
    createMockAgent("c1", "r1"),
    createMockAgent("c2", "r2"),
  ]);
  const result = await seq.execute({ stepName: "test", prompt: "go", round: 1, sessionId: "s1" });

  assert.equal(result.insights?.["c1-insight"], "r1");
  assert.equal(result.insights?.["c2-insight"], "r2");
});

test("SequentialAgent: dispose disposes children", () => {
  let disposed = false;
  const child = createMockAgent("c1", "r");
  child.dispose = () => { disposed = true; };

  const seq = new SequentialAgent(A, [child]);
  seq.dispose();
  assert.equal(disposed, true);
});

// ============================================================
// ParallelAgent (Wave 7.3)
// ============================================================

test("ParallelAgent: executes children concurrently", async () => {
  const start = Date.now();
  const par = new ParallelAgent(A, [
    createMockAgent("c1", "r1", 50),
    createMockAgent("c2", "r2", 50),
  ]);
  await par.execute({ stepName: "test", prompt: "go", round: 1, sessionId: "s1" });
  const elapsed = Date.now() - start;

  // If truly parallel, should take ~50ms not ~100ms
  assert.ok(elapsed < 120, `Expected parallel execution, took ${elapsed}ms`);
});

test("ParallelAgent: all strategy returns last result", async () => {
  const par = new ParallelAgent(A, [
    createMockAgent("c1", "first"),
    createMockAgent("c2", "second"),
  ], "all");
  const result = await par.execute({ stepName: "test", prompt: "go", round: 1, sessionId: "s1" });

  if (result.response.kind === "text") {
    assert.equal(result.response.content, "second");
  }
});

test("ParallelAgent: first-success picks non-failed result", async () => {
  const failChild = createMockAgent("fail", "");
  failChild.execute = async (t) => ({
    agentId: agentId("fail"),
    stepName: t.stepName,
    response: makeTextResponse("", true),
    durationMs: 0,
  });

  const par = new ParallelAgent(A, [failChild, createMockAgent("ok", "good")], "first-success");
  const result = await par.execute({ stepName: "test", prompt: "go", round: 1, sessionId: "s1" });

  assert.ok(!result.response.failed); // the "good" one
});

test("ParallelAgent: merges insights from all children", async () => {
  const par = new ParallelAgent(A, [
    createMockAgent("c1", "r1"),
    createMockAgent("c2", "r2"),
  ]);
  const result = await par.execute({ stepName: "test", prompt: "go", round: 1, sessionId: "s1" });

  assert.equal(result.insights?.["c1-insight"], "r1");
  assert.equal(result.insights?.["c2-insight"], "r2");
});

// ============================================================
// LoopAgent (Wave 7.3)
// ============================================================

test("LoopAgent: loops until termination condition", async () => {
  let callCount = 0;
  const child = createMockAgent("c1", "iter");
  const origExec = child.execute.bind(child);
  child.execute = async (t) => { callCount++; return origExec(t); };

  const loop = new LoopAgent(A, child, (_result, iteration) => iteration >= 3, 10);
  await loop.execute({ stepName: "test", prompt: "go", round: 1, sessionId: "s1" });

  assert.equal(callCount, 3);
});

test("LoopAgent: respects maxIterations", async () => {
  let callCount = 0;
  const child = createMockAgent("c1", "iter");
  const origExec = child.execute.bind(child);
  child.execute = async (t) => { callCount++; return origExec(t); };

  const loop = new LoopAgent(A, child, () => false, 2); // never terminates, but max 2
  await loop.execute({ stepName: "test", prompt: "go", round: 1, sessionId: "s1" });

  assert.equal(callCount, 2);
});

test("LoopAgent: passes round number correctly", async () => {
  const rounds: number[] = [];
  const child = createMockAgent("c1", "r");
  child.execute = async (t) => {
    rounds.push(t.round);
    return { agentId: agentId("c1"), stepName: t.stepName, response: makeTextResponse("r"), durationMs: 0 };
  };

  const loop = new LoopAgent(A, child, (_r, i) => i >= 3, 5);
  await loop.execute({ stepName: "test", prompt: "go", round: 1, sessionId: "s1" });

  assert.deepEqual(rounds, [1, 2, 3]);
});

// ============================================================
// DAGOrchestrator (Wave 7.3)
// ============================================================

function makeContext(steps: string[], completedSteps: string[] = []): OrchestrationContext {
  const results = new Map<string, AgentResult>();
  for (const s of completedSteps) {
    results.set(s, {
      agentId: A, stepName: s, response: makeTextResponse("done"), durationMs: 0,
    });
  }
  return {
    runId: "run-1", sessionId: "s1", steps,
    assignments: new Map(steps.map((s) => [s, A])),
    results, round: 1, sharedKnowledge: {},
  };
}

test("DAGOrchestrator: plan returns sequential steps", async () => {
  const orch = new DAGOrchestrator();
  const plan = await orch.plan(makeContext(["gen", "review", "apply"]));
  assert.deepEqual(plan.steps, ["gen", "review", "apply"]);
});

test("DAGOrchestrator: onStepComplete returns next step", async () => {
  const orch = new DAGOrchestrator();
  const ctx = makeContext(["gen", "review", "apply"]);
  const result: AgentResult = { agentId: A, stepName: "gen", response: makeTextResponse("ok"), durationMs: 0 };

  const next = await orch.onStepComplete(ctx, result);
  assert.equal(next.type, "continue");
  if (next.type === "continue") {
    assert.deepEqual(next.nextSteps, ["review"]);
  }
});

test("DAGOrchestrator: onStepComplete returns done when all finished", async () => {
  const orch = new DAGOrchestrator();
  const ctx = makeContext(["gen", "review"], ["gen"]);
  const result: AgentResult = { agentId: A, stepName: "review", response: makeTextResponse("ok"), durationMs: 0 };

  const next = await orch.onStepComplete(ctx, result);
  assert.equal(next.type, "done");
});

test("DAGOrchestrator: onStepFailed retries then aborts", async () => {
  const orch = new DAGOrchestrator(2);
  const ctx = makeContext(["gen"]);

  const retry = await orch.onStepFailed(ctx, { stepName: "gen", agentId: A, error: new Error("fail"), attempt: 1 });
  assert.equal(retry.type, "retry");

  const abort = await orch.onStepFailed(ctx, { stepName: "gen", agentId: A, error: new Error("fail"), attempt: 2 });
  assert.equal(abort.type, "abort");
});

test("LLMOrchestrator: plan returns sequential steps (fallback)", async () => {
  const orch = new LLMOrchestrator({
    providers: { mock: { type: "mock" } },
    pipeline: { a: ["mock"], b: ["mock", "a"] },
  });
  const plan = await orch.plan(makeContext(["a", "b"]));
  assert.deepEqual(plan.steps, ["a", "b"]);
});

// ============================================================
// AgentToolRegistry (Wave 7.3)
// ============================================================

test("AgentToolRegistry: register and invoke", async () => {
  const registry = new AgentToolRegistry();
  const agent = createMockAgent("coder", "code-result");
  registry.register({ name: "code", description: "Write code", agentId: agentId("coder") }, agent);

  assert.equal(registry.size, 1);
  assert.equal(registry.has("code"), true);

  const result = await registry.invoke("code", { stepName: "gen", prompt: "write", round: 1, sessionId: "s1" });
  if (result.response.kind === "text") {
    assert.equal(result.response.content, "code-result");
  }
});

test("AgentToolRegistry: invoke throws on unknown tool", async () => {
  const registry = new AgentToolRegistry();
  await assert.rejects(
    () => registry.invoke("nope", { stepName: "s", prompt: "p", round: 1, sessionId: "s1" }),
    /not found/
  );
});

test("AgentToolRegistry: getToolDefinitions", () => {
  const registry = new AgentToolRegistry();
  registry.register({ name: "t1", description: "d1", agentId: A }, createMockAgent("a", "r"));
  registry.register({ name: "t2", description: "d2", agentId: B }, createMockAgent("b", "r"));

  const defs = registry.getToolDefinitions();
  assert.equal(defs.length, 2);
});

test("AgentToolRegistry: unregister and clear", () => {
  const registry = new AgentToolRegistry();
  registry.register({ name: "t1", description: "d1", agentId: A }, createMockAgent("a", "r"));
  assert.equal(registry.unregister("t1"), true);
  assert.equal(registry.size, 0);
  assert.equal(registry.unregister("t1"), false);

  registry.register({ name: "t2", description: "d2", agentId: B }, createMockAgent("b", "r"));
  registry.clear();
  assert.equal(registry.size, 0);
});

// ============================================================
// Approval Gate (Wave 7.8)
// ============================================================

test("AutoApprovalGate: auto-approves below threshold", () => {
  const gate = new AutoApprovalGate("medium");
  assert.equal(gate.shouldApprove({ agentId: A, action: "read", risk: "low" }), false);
  assert.equal(gate.shouldApprove({ agentId: A, action: "write", risk: "medium" }), true);
  assert.equal(gate.shouldApprove({ agentId: A, action: "delete", risk: "high" }), true);
});

test("AutoApprovalGate: threshold high means only high needs approval", () => {
  const gate = new AutoApprovalGate("high");
  assert.equal(gate.shouldApprove({ agentId: A, action: "write", risk: "medium" }), false);
  assert.equal(gate.shouldApprove({ agentId: A, action: "delete", risk: "high" }), true);
});

test("AutoApprovalGate: requestApproval auto-approves", async () => {
  const gate = new AutoApprovalGate();
  const response = await gate.requestApproval({
    id: "a-1", agentId: A, action: "write", description: "write file", risk: "high", requestedAt: Date.now(),
  });
  assert.equal(response.decision, "approve");
});

test("CallbackApprovalGate: delegates to callback", async () => {
  const gate = new CallbackApprovalGate(
    async (req) => ({ decision: "reject" as const, reason: `denied: ${req.action}` }),
    "medium"
  );

  assert.equal(gate.shouldApprove({ agentId: A, action: "write", risk: "high" }), true);

  const response = await gate.requestApproval({
    id: "a-1", agentId: A, action: "write", description: "write file", risk: "high", requestedAt: Date.now(),
  });
  assert.equal(response.decision, "reject");
  if (response.decision === "reject") {
    assert.ok(response.reason.includes("write"));
  }
});

test("ApprovalManager: needsApproval delegates to gate", () => {
  const gate = new AutoApprovalGate("medium");
  const mgr = new ApprovalManager(gate);

  assert.equal(mgr.needsApproval({ agentId: A, action: "read", risk: "low" }), false);
  assert.equal(mgr.needsApproval({ agentId: A, action: "write", risk: "high" }), true);
});

test("ApprovalManager: requestApproval records audit log", async () => {
  const gate = new AutoApprovalGate();
  const mgr = new ApprovalManager(gate);

  const response = await mgr.requestApproval(
    { agentId: A, action: "write_file", risk: "high" },
    "Write to /src/main.ts"
  );

  assert.equal(response.decision, "approve");
  assert.equal(mgr.getRecords().length, 1);
  assert.equal(mgr.getRecords()[0].request.action, "write_file");
  assert.equal(mgr.getRecords()[0].request.description, "Write to /src/main.ts");
});

test("ApprovalManager: getRecordsForAgent filters correctly", async () => {
  const gate = new AutoApprovalGate();
  const mgr = new ApprovalManager(gate);

  await mgr.requestApproval({ agentId: A, action: "write", risk: "high" }, "a writes");
  await mgr.requestApproval({ agentId: B, action: "delete", risk: "high" }, "b deletes");
  await mgr.requestApproval({ agentId: A, action: "exec", risk: "high" }, "a execs");

  assert.equal(mgr.getRecordsForAgent(A).length, 2);
  assert.equal(mgr.getRecordsForAgent(B).length, 1);
});

test("ApprovalManager: clearRecords resets audit log", async () => {
  const gate = new AutoApprovalGate();
  const mgr = new ApprovalManager(gate);

  await mgr.requestApproval({ agentId: A, action: "write", risk: "high" }, "test");
  mgr.clearRecords();
  assert.equal(mgr.getRecords().length, 0);
});

test("CallbackApprovalGate: modify response", async () => {
  const gate = new CallbackApprovalGate(
    async () => ({ decision: "modify" as const, modifications: { maxFiles: 5 } }),
  );

  const response = await gate.requestApproval({
    id: "a-1", agentId: A, action: "write", description: "bulk write", risk: "high", requestedAt: Date.now(),
  });
  assert.equal(response.decision, "modify");
  if (response.decision === "modify") {
    assert.deepEqual(response.modifications, { maxFiles: 5 });
  }
});
