import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig, getDagStages, type PipelineConfig } from "../src/core/config.js";

function createBaseConfig(): PipelineConfig {
  return {
    pipeline: {
      generate: ["codex"],
      review: ["gemini", "generate"],
    },
    providers: {
      codex: { type: "cli", command: "codex" },
      gemini: { type: "cli", command: "gemini" },
    },
    retry: { maxRounds: 2, reviewStep: "review" },
  };
}

// --- validateConfig: dependencies ---

test("validateConfig rejects dependsOn referencing unknown step", () => {
  const config = createBaseConfig();
  config.pipeline.generate = ["codex", "nonexistent"];
  assert.throws(() => validateConfig(config), /dependsOn references unknown step "nonexistent"/);
});

test("validateConfig rejects self-referencing dependsOn", () => {
  const config = createBaseConfig();
  config.pipeline.generate = ["codex", "generate"];
  assert.throws(() => validateConfig(config), /cannot depend on itself/);
});

test("validateConfig accepts valid dependsOn", () => {
  const config = createBaseConfig();
  config.pipeline.review = ["gemini", "generate"];
  assert.doesNotThrow(() => validateConfig(config));
});

// --- getDagStages: linear fallback ---

test("getDagStages: linear stages produced by dependencies", () => {
  const config = createBaseConfig();
  const stages = getDagStages(config);
  assert.equal(stages.length, 2);
  assert.deepEqual(stages[0], ["generate"]);
  assert.deepEqual(stages[1], ["review"]);
});

// --- getDagStages: parallel stages ---

test("getDagStages: independent steps run in same stage", () => {
  const config: PipelineConfig = {
    pipeline: {
      stepA: ["codex"],
      stepB: ["gemini"],
      stepC: ["codex", "stepA", "stepB"],
    },
    providers: {
      codex: { type: "cli", command: "codex" },
      gemini: { type: "cli", command: "gemini" },
    },
  };

  const stages = getDagStages(config);
  assert.equal(stages.length, 2);
  assert.deepEqual(new Set(stages[0]), new Set(["stepA", "stepB"]));
  assert.deepEqual(stages[1], ["stepC"]);
});

// --- getDagStages: diamond dependency ---

test("getDagStages: diamond dependency resolves correctly", () => {
  const config: PipelineConfig = {
    pipeline: {
      start: ["codex"],
      left: ["codex", "start"],
      right: ["gemini", "start"],
      end: ["codex", "left", "right"],
    },
    providers: {
      codex: { type: "cli", command: "codex" },
      gemini: { type: "cli", command: "gemini" },
    },
  };

  const stages = getDagStages(config);
  assert.equal(stages.length, 3);
  assert.deepEqual(stages[0], ["start"]);
  assert.deepEqual(new Set(stages[1]), new Set(["left", "right"]));
  assert.deepEqual(stages[2], ["end"]);
});

// --- getDagStages: cycle detection ---

test("getDagStages: reflects in-place pipeline mutation without cache clear", () => {
  const config: PipelineConfig = {
    providers: { m: { type: "mock" } },
    pipeline: { a: ["m"] },
  };
  assert.deepEqual(getDagStages(config), [["a"]]);
  config.pipeline.b = ["m", "a"];
  const stages = getDagStages(config);
  assert.equal(stages.length, 2);
  assert.ok(stages.some((s) => s.includes("b")));
});

test("getDagStages: detects cycle in dependencies", () => {
  const config: PipelineConfig = {
    pipeline: {
      a: ["codex", "b"],
      b: ["codex", "a"],
    },
    providers: {
      codex: { type: "cli", command: "codex" },
    },
  };

  assert.throws(() => getDagStages(config), /Circular dependency detected/);
});
