import assert from "node:assert/strict";
import test from "node:test";
import type { PipelineConfig } from "../src/core/config.ts";
import {
  buildReflectPrompt,
  requestReflectExecutionPlan,
} from "../src/orchestration/reflect-planner.ts";
import { compileAgentGraphFromPipeline } from "../src/orchestration/agent-graph.ts";
import { LLMOrchestrator } from "../src/orchestration/orchestrator.ts";
import { agentId } from "../src/orchestration/multi-agent-types.ts";

function reflectConfig(): PipelineConfig {
  return {
    providers: {
      planner: { type: "mock", mode: "text" },
      worker: { type: "mock", mode: "text" },
    },
    pipeline: {
      implement: ["worker"],
      review: ["worker", "implement"],
    },
    retry: { maxRounds: 3, reviewStep: "review" },
    orchestration: {
      mode: "llm-driven",
      plannerProvider: "planner",
      reflect: { enabled: true, provider: "planner" },
    },
  };
}

test("buildReflectPrompt includes trigger and feedback", () => {
  const p = buildReflectPrompt(
    {
      runId: "r",
      steps: ["implement", "review"],
      results: new Map(),
      round: 2,
      sharedKnowledge: { review: "needs fix" },
      trigger: "review_revision",
      reviewFeedback: "fix edge cases",
    },
    ["implement", "review"],
  );
  assert.match(p, /review_revision/);
  assert.match(p, /fix edge cases/);
});

test("requestReflectExecutionPlan: mock returns implement before review", async () => {
  const config = reflectConfig();
  const plan = await requestReflectExecutionPlan(
    config,
    "planner",
    {
      runId: "r",
      steps: ["implement", "review"],
      results: new Map(),
      round: 2,
      sharedKnowledge: {},
      trigger: "review_revision",
    },
    ["implement", "review"],
  );
  assert.ok(plan);
  assert.deepEqual(plan!.steps, ["implement", "review"]);
});

test("LLMOrchestrator.reflectAndReplan updates agentGraph waves", async () => {
  const config = reflectConfig();
  const orch = new LLMOrchestrator(config);
  const graph = compileAgentGraphFromPipeline(config.pipeline);
  const ctx = {
    runId: "r1",
    sessionId: "s1",
    steps: ["implement", "review"],
    assignments: new Map([
      ["implement", agentId("implement")],
      ["review", agentId("review")],
    ]),
    results: new Map(),
    round: 2,
    sharedKnowledge: { review: "NEEDS_REVISION: fix tests" },
    agentGraph: graph,
  };

  const plan = await orch.reflectAndReplan(ctx, "review_revision", {
    reviewFeedback: "fix tests",
  });
  assert.ok(plan);
  assert.deepEqual(plan!.steps, ["implement", "review"]);
  const flat = graph.waves.flat();
  assert.equal(flat[flat.length - 1], "review");
});

test("reflect disabled returns null", async () => {
  const config = reflectConfig();
  config.orchestration!.reflect!.enabled = false;
  const orch = new LLMOrchestrator(config);
  const plan = await orch.reflectAndReplan(
    {
      runId: "r",
      sessionId: "s",
      steps: ["implement", "review"],
      assignments: new Map(),
      results: new Map(),
      round: 2,
      sharedKnowledge: {},
    },
    "review_revision",
  );
  assert.equal(plan, null);
});
