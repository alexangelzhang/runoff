import assert from "node:assert/strict";
import test from "node:test";
import type { PipelineConfig } from "../../src/core/config.ts";
import {
  agentGraphFromConfig,
  applyAgentGraphToPipeline,
  parseAgentGraphSnapshot,
  serializeAgentGraph,
} from "../../src/orchestration/agent-graph-io.ts";

const config: PipelineConfig = {
  providers: { mock: { type: "mock" } },
  pipeline: {
    generate: ["mock"],
    review: ["mock", "generate"],
  },
  retry: { maxRounds: 1 },
};

test("serializeAgentGraph round-trips nodes and waves", () => {
  const graph = agentGraphFromConfig(config);
  const snap = serializeAgentGraph(graph);
  const restored = parseAgentGraphSnapshot(snap);
  assert.equal(restored.nodes.size, 2);
  assert.deepEqual(restored.waves, graph.waves);
});

test("applyAgentGraphToPipeline updates config pipeline", () => {
  const pipeline = { ...config.pipeline };
  const snap = serializeAgentGraph(agentGraphFromConfig({ ...config, pipeline }));
  snap.nodes.push({ id: "lint", providers: "mock", dependsOn: ["generate"] });
  applyAgentGraphToPipeline(snap, pipeline);
  assert.ok(pipeline.lint);
  assert.deepEqual(pipeline.lint, ["mock", "generate"]);
});
