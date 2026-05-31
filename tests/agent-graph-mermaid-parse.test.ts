import assert from "node:assert/strict";
import test from "node:test";
import {
  agentGraphGroupLinksToMermaid,
  agentGraphToMermaid,
} from "../src/orchestration/agent-graph-viz.ts";
import {
  parseAgentGraphFromMermaid,
  parseAgentGraphGroupLinksFromMermaid,
} from "../src/orchestration/agent-graph-mermaid-parse.ts";
import type { AgentGraphSnapshot } from "../src/orchestration/agent-graph-io.ts";

const snap: AgentGraphSnapshot = {
  source: "config",
  waves: [["a"], ["c"]],
  nodes: [
    { id: "a", providers: "mock-a", dependsOn: [] },
    { id: "b", providers: ["mock-b", "mock-c"], dependsOn: ["a"] },
    { id: "c", providers: "mock-r", dependsOn: ["a", "b"] },
  ],
};

test("parseAgentGraphFromMermaid round-trips agentGraphToMermaid", () => {
  const md = agentGraphToMermaid(snap);
  const parsed = parseAgentGraphFromMermaid(md);
  assert.equal(parsed.nodes.length, 3);
  const c = parsed.nodes.find((n) => n.id === "c");
  assert.ok(c?.dependsOn.includes("a"));
  assert.ok(c?.dependsOn.includes("b"));
  assert.ok(parsed.waves.length >= 2);
});

test("parseAgentGraphFromMermaid throws on empty diagram", () => {
  assert.throws(() => parseAgentGraphFromMermaid("flowchart TD\n"), /No nodes parsed/);
});

test("parseAgentGraphGroupLinksFromMermaid round-trips export", () => {
  const snap: AgentGraphSnapshot = {
    source: "config",
    waves: [["a"]],
    nodes: [{ id: "a", providers: "mock", dependsOn: [] }],
    nodeMeta: { a: { group: "gen", parentGroup: "pipe" } },
    groupLinks: [{ from: "pipe/gen", to: "review" }],
  };
  const md = agentGraphGroupLinksToMermaid({
    ...snap,
    nodes: [...snap.nodes, { id: "review", providers: "mock", dependsOn: [] }],
  });
  const links = parseAgentGraphGroupLinksFromMermaid(md);
  assert.equal(links.length, 1);
  assert.equal(links[0]!.from, "pipe/gen");
  assert.equal(links[0]!.to, "review");
});
