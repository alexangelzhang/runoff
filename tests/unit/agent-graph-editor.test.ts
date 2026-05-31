import assert from "node:assert/strict";
import test from "node:test";
import { agentGraphToEditorHtml } from "../../src/orchestration/agent-graph-editor.js";
import type { AgentGraphSnapshot } from "../../src/orchestration/agent-graph-io.ts";

const snap: AgentGraphSnapshot = {
  source: "config",
  waves: [["a"], ["b"]],
  nodes: [
    { id: "a", providers: "mock-a", dependsOn: [] },
    { id: "b", providers: ["mock-b", "mock-c"], dependsOn: ["a"] },
  ],
};

test("agentGraphToEditorHtml embeds save URL when options.saveUrl set", () => {
  const html = agentGraphToEditorHtml(snap, "t", {
    saveUrl: "http://127.0.0.1:9999/api/save",
    configPathLabel: "/tmp/pipeline.config.json",
  });
  assert.match(html, /saveToConfig/);
  assert.match(html, /__lpSaveUrl/);
  assert.match(html, /127\.0\.0\.1:9999\/api\/save/);
});

test("agentGraphToEditorHtml embeds init payload and DOM script", () => {
  const html = agentGraphToEditorHtml(snap);
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /__agentGraphEditorInit/);
  assert.match(html, /"id":"a"/);
  assert.match(html, /createElement/);
  assert.doesNotMatch(html, /innerHTML/);
  assert.match(html, /recomputeWaves/);
  assert.match(html, /id="waves"/);
  assert.match(html, /draggable/);
  assert.match(html, /fromMermaid/);
  assert.match(html, /mermaidPreview/);
});
