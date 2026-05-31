import assert from "node:assert/strict";
import test from "node:test";
import {
  agentGraphGroupLinksToMermaid,
  agentGraphToHtml,
  agentGraphToMermaid,
} from "../../src/orchestration/agent-graph-viz.ts";
import type { AgentGraphSnapshot } from "../../src/orchestration/agent-graph-io.ts";

const snap: AgentGraphSnapshot = {
  source: "config",
  waves: [["alpha", "beta"], ["review"]],
  nodes: [
    { id: "alpha", providers: "mock-a", dependsOn: [] },
    { id: "beta", providers: "mock-b", dependsOn: [] },
    { id: "review", providers: "mock-r", dependsOn: ["alpha", "beta"] },
  ],
};

test("agentGraphToMermaid includes nodes and edges", () => {
  const md = agentGraphToMermaid(snap);
  assert.match(md, /flowchart TD/);
  assert.match(md, /alpha/);
  assert.match(md, /beta/);
  assert.match(md, /review/);
  assert.match(md, /alpha.*-->.*review/s);
});

test("agentGraphToHtml embeds mermaid block", () => {
  const html = agentGraphToHtml(snap);
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /class="mermaid"/);
});

test("agentGraphGroupLinksToMermaid exports group link edges", () => {
  const withGroups: AgentGraphSnapshot = {
    ...snap,
    nodeMeta: {
      alpha: { group: "gen", parentGroup: "pipe" },
      beta: { group: "gen", parentGroup: "pipe" },
    },
    groupLinks: [{ from: "pipe/gen", to: "review" }],
    nodes: [...snap.nodes, { id: "review", providers: "mock-r", dependsOn: [] }],
  };
  const md = agentGraphGroupLinksToMermaid(withGroups);
  assert.match(md, /flowchart LR/);
  assert.match(md, /pipe_gen.*-->.*review/);
});
