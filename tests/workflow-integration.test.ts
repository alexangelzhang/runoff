import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExecutionPlanFromPipeline,
  createOrchestrator,
  WorkflowOrchestrator,
} from "../src/orchestration/orchestrator.ts";
import { ParallelAgent } from "../src/orchestration/workflow-agents.ts";
import { agentId } from "../src/orchestration/multi-agent-types.ts";
import type { AgentInstance, AgentTask, AgentResult } from "../src/orchestration/agent.ts";
import { AgentState } from "../src/orchestration/agent-state.ts";
import type { LLMProvider, TextResponse } from "../src/providers/types.ts";

function mockAgent(id: string, label: string): AgentInstance {
  const aid = agentId(id);
  const resp: TextResponse = { kind: "text", content: label, code: label, explanation: "", model: "mock" };
  return {
    id: aid,
    role: "worker",
    capabilities: ["implement"],
    provider: { name: "mock", mode: "text", execute: async () => resp } as LLMProvider,
    state: new AgentState(aid),
    async execute(task: AgentTask): Promise<AgentResult> {
      return { agentId: aid, stepName: task.stepName, response: resp, durationMs: 1 };
    },
    dispose() {},
  };
}

test("buildExecutionPlanFromPipeline preserves parallel waves", () => {
  const plan = buildExecutionPlanFromPipeline({
    alpha: ["mock"],
    beta: ["mock"],
    review: ["mock", "alpha", "beta"],
  });
  assert.equal(plan.steps.length, 2);
  assert.ok(Array.isArray(plan.steps[0]));
  const wave0 = plan.steps[0] as string[];
  assert.deepEqual(wave0.sort(), ["alpha", "beta"]);
});

test("createOrchestrator returns WorkflowOrchestrator for workflow mode", () => {
  const orch = createOrchestrator({
    providers: { mock: { type: "mock" } },
    pipeline: { a: ["mock"] },
    orchestration: { mode: "workflow" },
  });
  assert.ok(orch instanceof WorkflowOrchestrator);
});

test("ParallelAgent.executeAll returns every child result", async () => {
  const par = new ParallelAgent(agentId("orch"), [
    mockAgent("alpha", "A"),
    mockAgent("beta", "B"),
  ]);
  const results = await par.executeAll({
    stepName: "stage",
    prompt: "p",
    round: 1,
    sessionId: "s",
  });
  assert.equal(results.length, 2);
});
