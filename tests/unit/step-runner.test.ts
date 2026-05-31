import assert from "node:assert/strict";
import test from "node:test";
import type { PipelineConfig } from "../../src/core/config.ts";
import { AgentRegistry } from "../../src/orchestration/registry.ts";
import { PipelineStepAgent } from "../../src/orchestration/pipeline-step-agent.ts";
import {
  AgentStepRunner,
  createAgentStepRunner,
  createConfigStepRunner,
  resolveStepRunner,
} from "../../src/orchestration/step-runner.ts";

const config: PipelineConfig = {
  providers: { mock: { type: "mock" } },
  pipeline: { generate: ["mock"] },
  retry: { maxRounds: 1, reviewStep: "review" },
};

test("createConfigStepRunner calls executePipelineStep", async () => {
  const runner = createConfigStepRunner(config);
  const outcome = await runner.executeStep("generate", {
    prompt: "x",
    sessionId: "s1",
    round: 1,
    globalKnowledge: {},
    candidate: { code: "" },
  } as never);
  assert.equal(outcome.stepName, "generate");
});

test("resolveStepRunner prefers explicit stepRunner", () => {
  const custom = createConfigStepRunner(config);
  const resolved = resolveStepRunner({
    runtimeConfig: config,
    stepRunner: custom,
    agentRegistry: AgentRegistry.fromPipelineSteps(config, "review"),
  });
  assert.equal(resolved, custom);
});

test("resolveStepRunner builds AgentStepRunner when registry present", () => {
  const registry = AgentRegistry.fromPipelineSteps(config, "review");
  const resolved = resolveStepRunner({
    runtimeConfig: config,
    agentRegistry: registry,
  });
  assert.ok(resolved instanceof AgentStepRunner);
});

test("resolveStepRunner throws without stepRunner or agentRegistry", () => {
  assert.throws(
    () => resolveStepRunner({ runtimeConfig: config }),
    /stepRunner or agentRegistry/,
  );
});

test("AgentStepRunner uses PipelineStepAgent from registry", async () => {
  const registry = AgentRegistry.fromPipelineSteps(config, "review");
  const agent = registry.getOrThrow("generate" as never);
  assert.ok(agent instanceof PipelineStepAgent);

  let viaAgent = false;
  agent.executeWithContext = async () => {
    viaAgent = true;
    return {
      stepName: "generate",
      usedProvider: "mock",
      upgraded: false,
      durationMs: 1,
      trace: { name: "generate", provider: "mock", durationMs: 1, round: 1 },
      response: {
        kind: "text" as const,
        model: "mock",
        content: "",
        code: "",
        explanation: "",
      },
    };
  };

  const runner = createAgentStepRunner(registry, config);
  await runner.executeStep("generate", {
    prompt: "x",
    sessionId: "s1",
    round: 1,
    globalKnowledge: {},
    candidate: { code: "" },
  } as never);
  assert.equal(viaAgent, true);
});
