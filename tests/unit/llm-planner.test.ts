import assert from "node:assert/strict";
import test from "node:test";
import type { PipelineConfig } from "../../src/core/config.ts";
import {
  parsePlannerPlanJson,
  requestLlmExecutionPlan,
  buildPlannerPrompt,
} from "../../src/orchestration/llm-planner.ts";
import { LLMOrchestrator } from "../../src/orchestration/orchestrator.ts";

test("parsePlannerPlanJson: parses JSON blob", () => {
  const plan = parsePlannerPlanJson('{"steps":["a","b"],"maxRounds":2}');
  assert.deepEqual(plan?.steps, ["a", "b"]);
  assert.equal(plan?.maxRounds, 2);
});

test("requestLlmExecutionPlan: mock planner returns valid plan", async () => {
  const config: PipelineConfig = {
    providers: {
      planner: { type: "mock", mode: "text" },
      worker: { type: "mock", mode: "text" },
    },
    pipeline: {
      implement: ["worker"],
      review: ["worker", "implement"],
    },
    orchestration: { mode: "llm-driven", plannerProvider: "planner" },
  };

  const plan = await requestLlmExecutionPlan(
    config,
    "planner",
    {
      runId: "r",
      steps: ["implement", "review"],
      results: new Map(),
      round: 1,
      sharedKnowledge: {},
    },
    ["implement", "review"],
  );

  assert.ok(plan);
  assert.deepEqual(plan!.steps, ["implement", "review"]);
  assert.equal(plan!.maxRounds, 4);
});

test("LLMOrchestrator.plan uses planner on round 1", async () => {
  const config: PipelineConfig = {
    providers: {
      planner: { type: "mock", mode: "text" },
      worker: { type: "mock", mode: "text" },
    },
    pipeline: {
      implement: ["worker"],
      review: ["worker", "implement"],
    },
    orchestration: { mode: "llm-driven", plannerProvider: "planner" },
  };

  const orch = new LLMOrchestrator(config);
  const plan = await orch.plan({
    runId: "r1",
    sessionId: "s1",
    steps: ["implement", "review"],
    assignments: new Map(),
    results: new Map(),
    round: 1,
    sharedKnowledge: {},
  });

  assert.deepEqual(plan.steps, ["implement", "review"]);
  assert.ok(buildPlannerPrompt(
    { runId: "r", steps: ["implement"], results: new Map(), round: 1, sharedKnowledge: {} },
    ["implement"],
  ).includes("implement"));
});
