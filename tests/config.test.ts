import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig, type PipelineConfig } from "../src/core/config.ts";

function createBaseConfig(): PipelineConfig {
  return {
    pipeline: {
      generate: ["codex"],
      review: ["gemini", "generate"],
    },
    providers: {
      codex: {
        type: "cli",
        command: "codex",
      },
      gemini: {
        type: "cli",
        command: "gemini",
      },
      claude: {
        type: "builtin",
      },
    },
    retry: {
      maxRounds: 2,
      reviewStep: "review",
    },
  };
}

test("validateConfig accepts valid DAG config", () => {
  const config = createBaseConfig();
  assert.equal(validateConfig(config), true);
});

test("validateConfig rejects non-array step config", () => {
  const config = createBaseConfig() as any;
  config.pipeline.generate = { provider: "codex" };

  assert.throws(
    () => validateConfig(config),
    /tuple DSL|JSON arrays/i
  );
});

test("validateConfig rejects unknown provider reference", () => {
  const config = createBaseConfig() as any;
  config.pipeline.generate = ["nonexistent"];

  assert.throws(
    () => validateConfig(config),
    /references unknown provider "nonexistent"/
  );
});

test("validateConfig rejects self-dependency", () => {
  const config = createBaseConfig();
  config.pipeline.generate = ["codex", "generate"];

  assert.throws(
    () => validateConfig(config),
    /cannot depend on itself/
  );
});

test("validateConfig rejects unknown dependency", () => {
  const config = createBaseConfig();
  config.pipeline.generate = ["codex", "missing_step"];

  assert.throws(
    () => validateConfig(config),
    /references unknown step "missing_step"/
  );
});

test("validateConfig accepts race mode (multi-provider array)", () => {
  const config = createBaseConfig();
  config.pipeline.generate = [["codex", "gemini"]];

  assert.equal(validateConfig(config), true);
});

test("validateConfig rejects invalid provider tier hints", () => {
  const config = createBaseConfig();
  config.providers.codex = { type: "mock", tier: "turbo" as "lite" };

  assert.throws(() => validateConfig(config), /tier must be "lite" or "full"/);
});
