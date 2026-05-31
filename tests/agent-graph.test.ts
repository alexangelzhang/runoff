import assert from "node:assert/strict";
import test from "node:test";
import { getDagStages } from "../src/core/config.ts";
import type { PipelineConfig } from "../src/core/config.ts";
import {
  agentGraphToExecutionPlan,
  agentGraphToStages,
  appendNodeToAgentGraph,
  applyExecutionPlanToAgentGraph,
  compileAgentGraphFromPipeline,
  syncExecutionPlanFromAgentGraph,
} from "../src/orchestration/agent-graph.ts";
import { buildExecutionPlanFromPipeline } from "../src/orchestration/orchestrator.ts";
import { executionPlanToStages } from "../src/orchestration/plan-scheduler.ts";

const config: PipelineConfig = {
  providers: { mock: { type: "mock" } },
  pipeline: {
    generate: ["mock"],
    review: ["mock", "generate"],
  },
  retry: { maxRounds: 2, reviewStep: "review" },
};

test("compileAgentGraphFromPipeline waves match getDagStages", () => {
  const graph = compileAgentGraphFromPipeline(config.pipeline);
  assert.deepEqual(agentGraphToStages(graph), getDagStages(config));
  assert.equal(graph.nodes.size, 2);
  assert.equal(graph.nodes.get("review")?.dependsOn.join(","), "generate");
});

test("agentGraphToExecutionPlan matches buildExecutionPlanFromPipeline", () => {
  const graph = compileAgentGraphFromPipeline(config.pipeline);
  const fromGraph = agentGraphToExecutionPlan(graph);
  const fromBuilder = buildExecutionPlanFromPipeline(config.pipeline);
  assert.deepEqual(fromGraph.steps, fromBuilder.steps);
});

test("applyExecutionPlanToAgentGraph updates waves (B6)", () => {
  const graph = compileAgentGraphFromPipeline(config.pipeline);
  applyExecutionPlanToAgentGraph(graph, { steps: [["generate", "review"]] });
  assert.deepEqual(graph.waves, [["generate", "review"]]);
  assert.equal(graph.source, "dynamic");
});

test("dynamic appendNodeToAgentGraph refreshes waves and plan", () => {
  const pipeline = { ...config.pipeline };
  const graph = compileAgentGraphFromPipeline(pipeline);
  const plan = agentGraphToExecutionPlan(graph);
  pipeline.lint = ["mock", "generate"];
  appendNodeToAgentGraph(
    graph,
    "lint",
    { providers: "mock", dependsOn: ["generate"] },
    pipeline,
  );
  assert.equal(graph.source, "dynamic");
  syncExecutionPlanFromAgentGraph(plan, graph);
  assert.deepEqual(executionPlanToStages(plan), getDagStages({ ...config, pipeline }));
});
