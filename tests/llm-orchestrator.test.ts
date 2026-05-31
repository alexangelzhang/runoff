import assert from "node:assert/strict";
import test from "node:test";
import { compileAgentGraphFromPipeline } from "../src/orchestration/agent-graph.ts";
import { LLMOrchestrator, type OrchestrationContext } from "../src/orchestration/orchestrator.ts";
import type { PipelineConfig } from "../src/core/config.ts";
import { agentId } from "../src/orchestration/multi-agent-types.ts";
import type { AgentResult } from "../src/orchestration/agent.ts";

function baseConfig(): PipelineConfig {
  return {
    providers: { mock: { type: "mock" } },
    pipeline: {
      implement: ["mock"],
      review: ["mock", "implement"],
    },
    retry: { maxRounds: 2, reviewStep: "review" },
    orchestration: { mode: "llm-driven" },
  };
}

function makeContext(overrides: Partial<OrchestrationContext> = {}): OrchestrationContext {
  return {
    runId: "run-1",
    sessionId: "sess-1",
    steps: ["implement", "review"],
    assignments: new Map([
      ["implement", agentId("implement")],
      ["review", agentId("review")],
    ]),
    results: new Map(),
    round: 1,
    sharedKnowledge: {},
    ...overrides,
  };
}

test("LLMOrchestrator: plan uses DAG stages from pipeline", async () => {
  const orch = new LLMOrchestrator(baseConfig());
  const ctx = makeContext({
    agentGraph: compileAgentGraphFromPipeline(baseConfig().pipeline),
  });
  const plan = await orch.plan(ctx);
  assert.deepEqual(plan.steps, ["implement", "review"]);
  assert.deepEqual(ctx.agentGraph?.waves, [["implement"], ["review"]]);
});

test("LLMOrchestrator: revision round reorders agentGraph waves", async () => {
  const cfg = baseConfig();
  const orch = new LLMOrchestrator(cfg);
  const ctx = makeContext({
    round: 2,
    agentGraph: compileAgentGraphFromPipeline(cfg.pipeline),
    sharedKnowledge: { review: "needs revision on edge cases" },
  });
  await orch.plan(ctx);
  const flat = ctx.agentGraph!.waves.flat();
  assert.equal(flat[flat.length - 1], "review");
});

test("LLMOrchestrator: onStepComplete routes revision back to implement", async () => {
  const orch = new LLMOrchestrator(baseConfig());
  const ctx = makeContext({
    results: new Map([
      [
        "implement",
        {
          agentId: agentId("implement"),
          stepName: "implement",
          durationMs: 1,
          response: {
            kind: "text",
            model: "mock",
            content: "done",
            code: "",
            explanation: "",
          },
        },
      ],
    ]),
  });

  const result: AgentResult = {
    agentId: agentId("review"),
    stepName: "review",
    durationMs: 1,
    response: {
      kind: "text",
      model: "mock",
      content: "VERDICT: NEEDS_REVISION\nPlease fix edge cases.",
      code: "",
      explanation: "",
    },
  };

  const next = await orch.onStepComplete(ctx, result);
  assert.equal(next.type, "continue");
  if (next.type === "continue") {
    assert.deepEqual(next.nextSteps, ["implement"]);
  }
});

test("LLMOrchestrator: onStepFailed retries on timeout before abort", async () => {
  const orch = new LLMOrchestrator(baseConfig(), 2);
  const ctx = makeContext();

  const retry = await orch.onStepFailed(ctx, {
    stepName: "implement",
    agentId: agentId("implement"),
    error: new Error("timed out"),
    attempt: 1,
  });
  assert.equal(retry.type, "fallback");

  const abort = await orch.onStepFailed(ctx, {
    stepName: "implement",
    agentId: agentId("implement"),
    error: new Error("timed out"),
    attempt: 2,
  });
  assert.equal(abort.type, "abort");
});
