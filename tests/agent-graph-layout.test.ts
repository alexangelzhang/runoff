import assert from "node:assert/strict";
import test from "node:test";
import { computeDagWaveLayout } from "../src/orchestration/agent-graph-layout.ts";
import type { AgentGraphSnapshot } from "../src/orchestration/agent-graph-io.ts";

const snap: AgentGraphSnapshot = {
  source: "config",
  waves: [["a"], ["b", "c"]],
  nodes: [
    { id: "a", providers: "mock", dependsOn: [] },
    { id: "b", providers: "mock", dependsOn: ["a"] },
    { id: "c", providers: "mock", dependsOn: ["a"] },
  ],
};

test("computeDagWaveLayout assigns positions per wave", () => {
  const layout = computeDagWaveLayout(snap);
  assert.ok(layout.a);
  assert.ok(layout.b);
  assert.ok(layout.c);
  assert.ok(layout.a!.y < layout.b!.y);
  assert.notEqual(layout.b!.x, layout.c!.x);
});
