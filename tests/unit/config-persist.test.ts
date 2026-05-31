import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { saveGraphSnapshotToConfigFile } from "../../src/pipeline/config-persist.js";
import type { AgentGraphSnapshot } from "../../src/orchestration/agent-graph-io.js";

const baseConfig = {
  providers: {
    mock: { type: "mock" },
    reviewer: { type: "mock" },
  },
  pipeline: {
    implement: ["mock"],
    review: ["reviewer", "implement"],
  },
  retry: { maxRounds: 2, reviewStep: "review" },
};

test("saveGraphSnapshotToConfigFile writes pipeline and preserves providers", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-config-persist-"));
  const configPath = join(dir, "pipeline.config.json");
  writeFileSync(configPath, JSON.stringify(baseConfig, null, 2));

  const snapshot: AgentGraphSnapshot = {
    source: "config",
    waves: [["plan"], ["implement"], ["review"]],
    nodes: [
      { id: "plan", providers: "mock", dependsOn: [] },
      { id: "implement", providers: "mock", dependsOn: ["plan"] },
      { id: "review", providers: "reviewer", dependsOn: ["implement"] },
    ],
  };

  const result = saveGraphSnapshotToConfigFile(configPath, snapshot);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const onDisk = JSON.parse(readFileSync(configPath, "utf-8")) as typeof baseConfig;
  assert.deepEqual(Object.keys(onDisk.pipeline).sort(), ["implement", "plan", "review"]);
  assert.equal(onDisk.providers.mock.type, "mock");
  assert.equal(onDisk.retry.maxRounds, 2);

  rmSync(dir, { recursive: true, force: true });
});

test("saveGraphSnapshotToConfigFile rejects cycles", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-config-persist-"));
  const configPath = join(dir, "pipeline.config.json");
  writeFileSync(configPath, JSON.stringify(baseConfig, null, 2));

  const snapshot: AgentGraphSnapshot = {
    source: "config",
    waves: [],
    nodes: [
      { id: "a", providers: "mock", dependsOn: ["b"] },
      { id: "b", providers: "mock", dependsOn: ["a"] },
    ],
  };

  const result = saveGraphSnapshotToConfigFile(configPath, snapshot);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /cycle/i);

  rmSync(dir, { recursive: true, force: true });
});
