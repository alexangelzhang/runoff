import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig, type PipelineConfig } from "../src/config.ts";

function createBaseConfig(): PipelineConfig {
  return {
    pipeline: {
      generate: { provider: "codex", order: 1 },
      review: { provider: "gemini", order: 2 },
    },
    providers: {
      codex: {
        type: "cli",
        command: "codex",
        mode: "agent-write",
      },
      gemini: {
        type: "cli",
        command: "gemini",
        mode: "agent-readonly",
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

test("validateConfig accepts readonly review providers", () => {
  const config = createBaseConfig();
  assert.equal(validateConfig(config), config);
});

test("validateConfig rejects builtin review steps", () => {
  const config = createBaseConfig();
  config.pipeline.review.provider = "claude";

  assert.throws(
    () => validateConfig(config),
    /retry\.reviewStep "review" cannot use builtin provider "claude"/
  );
});

test("validateConfig rejects agent-write review steps", () => {
  const config = createBaseConfig();
  config.providers.gemini.mode = "agent-write";

  assert.throws(
    () => validateConfig(config),
    /must use text or agent-readonly mode/
  );
});

test("validateConfig rejects invalid retry maxRounds", () => {
  const config = createBaseConfig();
  config.retry!.maxRounds = 0;

  assert.throws(
    () => validateConfig(config),
    /retry\.maxRounds must be a positive integer/
  );
});

test("validateConfig accepts agent provider in race mode", () => {
  const config = createBaseConfig();
  config.providers.agentProv = { type: "cli", command: "agent", mode: "agent-write" };
  config.modes = {
    race: { type: "race", providers: ["agentProv"] },
  };

  assert.equal(validateConfig(config), config);
});

test("validateConfig accepts text provider in race mode", () => {
  const config = createBaseConfig();
  config.providers.textProv = { type: "cli", command: "text-cli", mode: "text" };
  config.modes = {
    race: { type: "race", providers: ["textProv"] },
  };

  assert.equal(validateConfig(config), config);
});
