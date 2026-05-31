import assert from "node:assert/strict";
import test from "node:test";
import { emptyCandidate } from "../../src/core/candidate.ts";
import type { PipelineConfig } from "../../src/core/config.ts";
import { forkPipelineForRun, resolveReviewStepName } from "../../src/orchestration/runtime-pipeline.ts";
import { executePipelineStep } from "../../src/orchestration/step-execution.ts";

function makeBaseConfig(): PipelineConfig {
  return {
    providers: {
      slow: { type: "mock" },
      fast: { type: "mock" },
      reviewer: { type: "mock" },
    },
    pipeline: {
      implement: ["slow"],
      qa: ["slow", "implement"],
    },
  };
}

test("forkPipelineForRun uses explicit agent providers in dag mode", () => {
  const runtime = forkPipelineForRun({
    ...makeBaseConfig(),
    agents: {
      implement: { role: "worker", provider: "fast" },
      qa: { role: "reviewer", provider: "reviewer" },
    },
  });

  assert.equal(runtime.pipeline.implement[0], "fast");
  assert.equal(runtime.pipeline.qa[0], "reviewer");
  assert.equal(resolveReviewStepName(runtime), "qa");
});

test("forkPipelineForRun builds workflow order from agents and enforces handoff budget", () => {
  const runtime = forkPipelineForRun({
    ...makeBaseConfig(),
    agents: {
      plan: { role: "orchestrator", provider: "fast" },
      implement: { role: "worker", provider: "slow" },
      qa: { role: "reviewer", provider: "reviewer" },
    },
    orchestration: { mode: "workflow", maxHandoffs: 2, conflictResolution: "pick-winner" },
  });

  assert.deepEqual(runtime.pipeline, {
    plan: ["fast"],
    implement: ["slow", "plan"],
    qa: ["reviewer", "implement"],
  });

  assert.throws(
    () =>
      forkPipelineForRun({
        ...makeBaseConfig(),
        agents: {
          plan: { role: "orchestrator", provider: "fast" },
          implement: { role: "worker", provider: "slow" },
          qa: { role: "reviewer", provider: "reviewer" },
        },
        orchestration: { mode: "workflow", maxHandoffs: 1, conflictResolution: "pick-winner" },
      }),
    /maxHandoffs/,
  );
});

test("executePipelineStep supports auto-merge for provider races", async () => {
  const config = {
    providers: {
      a: { type: "mock" },
      b: { type: "mock" },
    },
    pipeline: {
      implement: [["a", "b"]],
    },
    orchestration: { mode: "dag", conflictResolution: "auto-merge" },
  };

  const outcome = await executePipelineStep(config, "implement", {
    prompt: "race",
    sessionId: "trace-1",
    pipelineSessionId: "session-1",
    round: 1,
    globalKnowledge: {},
    candidate: emptyCandidate(),
  });
  assert.equal(outcome.trace.raceMergeStrategy, "auto-merge");
  assert.equal(outcome.trace.raceMerged, true);
  assert.ok(outcome.usedProvider.length > 0);
});
