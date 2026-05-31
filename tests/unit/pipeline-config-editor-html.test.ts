import assert from "node:assert/strict";
import test from "node:test";
import { pipelineConfigToEditorHtml } from "../../src/pipeline/pipeline-config-editor-html.js";
import type { PipelineConfig } from "../../src/core/config.js";

const cfg: PipelineConfig = {
  providers: { mock: { type: "mock" } },
  pipeline: { implement: ["mock"] },
  retry: { maxRounds: 1 },
  routing: [],
};

test("pipelineConfigToEditorHtml includes C2 tabs and save", () => {
  const html = pipelineConfigToEditorHtml(cfg, "test", {
    saveUrl: "http://127.0.0.1:1/api/save",
    configPathLabel: "/tmp/pipeline.config.json",
  });
  assert.match(html, /panelProviders/);
  assert.match(html, /panelPipeline/);
  assert.match(html, /panelAdvanced/);
  assert.match(html, /raceFinalize/);
  assert.match(html, /saveToConfig/);
  assert.match(html, /__lpConfigEditorInit/);
  assert.doesNotMatch(html, /innerHTML/);
});
