import assert from "node:assert/strict";
import test from "node:test";
import {
  findDanglingGroupKeys,
  findPipelineCycle,
  isPlaceholderGraphNode,
  placeholderNodeIdForGroupKey,
  removePlaceholderGraphNodes,
  repairDanglingGroupLinks,
  recomputeSnapshotWaves,
  validateAgentGraphSnapshot,
} from "../src/orchestration/agent-graph-validate.ts";
import type { AgentGraphSnapshot } from "../src/orchestration/agent-graph-io.ts";

test("findPipelineCycle detects simple cycle", () => {
  const pipeline = {
    a: ["m", "c"],
    b: ["m", "a"],
    c: ["m", "b"],
  };
  const cycle = findPipelineCycle(pipeline);
  assert.ok(cycle && cycle.length >= 3);
});

test("validateAgentGraphSnapshot rejects cycle and missing deps", () => {
  const cyclic: AgentGraphSnapshot = {
    source: "config",
    waves: [],
    nodes: [
      { id: "a", providers: "m", dependsOn: ["b"] },
      { id: "b", providers: "m", dependsOn: ["a"] },
    ],
  };
  assert.equal(validateAgentGraphSnapshot(cyclic).valid, false);

  const missing: AgentGraphSnapshot = {
    source: "config",
    waves: [],
    nodes: [{ id: "x", providers: "m", dependsOn: ["ghost"] }],
  };
  const m = validateAgentGraphSnapshot(missing);
  assert.equal(m.valid, false);
  assert.ok(m.missingDeps?.includes("x→ghost"));
});

test("findDanglingGroupKeys detects group link without member nodes", () => {
  const snap: AgentGraphSnapshot = {
    source: "config",
    waves: [["a"]],
    nodes: [{ id: "a", providers: "m", dependsOn: [] }],
    nodeMeta: { a: { group: "gen" } },
    groupLinks: [{ from: "gen", to: "orphan" }],
  };
  assert.deepEqual(findDanglingGroupKeys(snap), ["orphan"]);
  assert.equal(validateAgentGraphSnapshot(snap).valid, false);
});

test("repairDanglingGroupLinks remove-links clears invalid edges", () => {
  const snap: AgentGraphSnapshot = {
    source: "config",
    waves: [["a"]],
    nodes: [{ id: "a", providers: "m", dependsOn: [] }],
    nodeMeta: { a: { group: "gen" } },
    groupLinks: [{ from: "gen", to: "orphan" }],
  };
  const fixed = repairDanglingGroupLinks(snap, "remove-links");
  assert.equal(fixed.groupLinks?.length, 0);
  assert.equal(validateAgentGraphSnapshot(fixed).valid, true);
});

test("repairDanglingGroupLinks placeholder-nodes adds group member", () => {
  const snap: AgentGraphSnapshot = {
    source: "config",
    waves: [["a"]],
    nodes: [{ id: "a", providers: "m", dependsOn: [] }],
    nodeMeta: { a: { group: "gen" } },
    groupLinks: [{ from: "gen", to: "pipe/review" }],
  };
  const fixed = repairDanglingGroupLinks(snap, "placeholder-nodes");
  const pid = placeholderNodeIdForGroupKey("pipe/review");
  assert.ok(fixed.nodes.some((n) => n.id === pid));
  assert.equal(fixed.nodeMeta?.[pid]?.group, "review");
  assert.equal(fixed.nodeMeta?.[pid]?.parentGroup, "pipe");
  assert.equal(fixed.nodeMeta?.[pid]?.placeholder, true);
  assert.equal(isPlaceholderGraphNode(pid, fixed.nodeMeta?.[pid]), true);
  assert.equal(validateAgentGraphSnapshot(fixed).valid, true);
});

test("removePlaceholderGraphNodes strips placeholder nodes and deps", () => {
  const snap: AgentGraphSnapshot = {
    source: "config",
    waves: [["a", "__grp__pipe_review"], ["b"]],
    nodes: [
      { id: "a", providers: "m", dependsOn: [] },
      { id: "__grp__pipe_review", providers: "mock", dependsOn: [] },
      { id: "b", providers: "m", dependsOn: ["__grp__pipe_review"] },
    ],
    nodeMeta: {
      a: { group: "gen" },
      __grp__pipe_review: { group: "review", parentGroup: "pipe", placeholder: true },
    },
  };
  const fixed = removePlaceholderGraphNodes(snap);
  assert.equal(fixed.nodes.length, 2);
  assert.ok(fixed.nodes.every((n) => n.id !== "__grp__pipe_review"));
  assert.deepEqual(fixed.nodes.find((n) => n.id === "b")?.dependsOn, []);
  assert.equal(fixed.nodeMeta?.__grp__pipe_review, undefined);
  assert.deepEqual(fixed.waves, [["a", "b"]]);
  assert.ok(fixed.layout?.a);
  assert.ok(fixed.layout?.b);
  assert.equal(fixed.layout?.__grp__pipe_review, undefined);
});

test("recomputeSnapshotWaves matches topological order", () => {
  const snap: AgentGraphSnapshot = {
    source: "config",
    waves: [],
    nodes: [
      { id: "a", providers: "m", dependsOn: [] },
      { id: "b", providers: "m", dependsOn: [] },
      { id: "c", providers: "m", dependsOn: ["a", "b"] },
    ],
  };
  const waves = recomputeSnapshotWaves(snap);
  assert.deepEqual(waves[0].sort(), ["a", "b"]);
  assert.deepEqual(waves[1], ["c"]);
});
