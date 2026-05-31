import assert from "node:assert/strict";
import test from "node:test";
import { getDagStages } from "../../src/core/config.ts";
import type { PipelineConfig } from "../../src/core/config.ts";
import {
  buildExecutionPlanFromPipeline,
  DAGOrchestrator,
} from "../../src/orchestration/orchestrator.ts";
import {
  executionPlanToStages,
  flattenExecutionPlan,
} from "../../src/orchestration/plan-scheduler.ts";

const config: PipelineConfig = {
  providers: { mock: { type: "mock" } },
  pipeline: {
    generate: ["mock"],
    review: ["mock", "generate"],
  },
  retry: { maxRounds: 2, reviewStep: "review" },
};

test("executionPlanToStages matches getDagStages for same pipeline", () => {
  const plan = buildExecutionPlanFromPipeline(config.pipeline);
  const fromPlan = executionPlanToStages(plan);
  const fromDag = getDagStages(config);
  assert.deepEqual(fromPlan, fromDag);
});

test("flattenExecutionPlan preserves step order", () => {
  const plan = buildExecutionPlanFromPipeline(config.pipeline);
  assert.deepEqual(flattenExecutionPlan(plan), ["generate", "review"]);
});

test("DAGOrchestrator onStepComplete returns done when all steps finished", async () => {
  const orch = new DAGOrchestrator(config.pipeline);
  const context = {
    runId: "r1",
    sessionId: "s1",
    steps: ["generate", "review"],
    assignments: new Map(),
    results: new Map(),
    round: 1,
    sharedKnowledge: {},
  };
  context.results.set("generate", {
    agentId: "generate" as never,
    stepName: "generate",
    response: {
      kind: "text",
      model: "mock",
      content: "",
      code: "",
      explanation: "",
    },
    durationMs: 1,
  });
  const next = await orch.onStepComplete(context, {
    agentId: "review" as never,
    stepName: "review",
    response: {
      kind: "text",
      model: "mock",
      content: "VERDICT: APPROVED",
      code: "",
      explanation: "",
    },
    durationMs: 1,
  });
  assert.equal(next.type, "done");
  if (next.type === "done") assert.equal(next.success, true);
});
