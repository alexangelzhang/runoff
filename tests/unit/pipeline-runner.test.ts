import assert from "node:assert/strict";
import test from "node:test";
import { emptyCandidate } from "../../src/core/candidate.ts";
import type { PipelineConfig } from "../../src/core/config.ts";
import { runPipelineDAGLoop } from "../../src/orchestration/pipeline-runner.ts";
import { CostTracker } from "../../src/routing/pricing.ts";
import type { StepResult } from "../../src/core/state.ts";
import type { SchedulerContext, StepOutcome } from "../../src/orchestration/step-execution.ts";
import { artifactsFromStepResponse } from "../../src/orchestration/artifact-bridge.ts";
import { isCodeArtifact } from "../../src/orchestration/artifacts.ts";

function makeConfig(): PipelineConfig {
  return {
    providers: { mock: { type: "mock" } },
    pipeline: {
      generate: ["mock"],
      review: ["mock", "generate"],
    },
    retry: { maxRounds: 2, reviewStep: "review" },
  };
}

function makeTrace(stepName: string, round: number) {
  return {
    name: stepName,
    provider: "mock",
    durationMs: 1,
    round,
  };
}

test("runPipelineDAGLoop reruns steps in a new round after review rejection", async () => {
  const calls: string[] = [];
  const stepRunner = {
    async executeStep(stepName: string, ctx: SchedulerContext): Promise<StepOutcome> {
      calls.push(`${stepName}@${ctx.round}`);
      if (stepName === "generate") {
        const response = {
          kind: "text" as const,
          content: `generated-${ctx.round}`,
          code: `generated-${ctx.round}`,
          explanation: "",
          model: "mock",
        };
        return {
          stepName,
          usedProvider: "mock",
          upgraded: false,
          routedFrom: undefined,
          durationMs: 1,
          trace: makeTrace(stepName, ctx.round),
          response,
          candidateSnapshot: { code: `generated-${ctx.round}`, isAgent: false },
          verdict: { approved: false, feedback: "" },
          artifacts: artifactsFromStepResponse(response, { stepName }),
        };
      }

      const approved = ctx.round >= 2;
      return {
        stepName,
        usedProvider: "mock",
        upgraded: false,
        routedFrom: undefined,
        durationMs: 1,
        trace: makeTrace(stepName, ctx.round),
        response: {
          kind: "text",
          content: approved ? "VERDICT: APPROVED" : "VERDICT: NEEDS_REVISION: fix it",
          code: "",
          explanation: "",
          model: "mock",
        },
        verdict: {
          approved,
          feedback: approved ? "" : "fix it",
        },
      };
    },
  } as const;

  const state = {
    stepResults: {} as Record<string, StepResult>,
    stepTraces: [],
    globalKnowledge: {},
    candidate: emptyCandidate(),
    approved: false,
    lastReviewFeedback: "",
  };

  const result = await runPipelineDAGLoop({
    runtimeConfig: makeConfig(),
    stepRunner: stepRunner as never,
    costTracker: new CostTracker(),
    state,
    pipelineSessionId: "session-1",
    startRound: 1,
    maxRounds: 2,
    reviewStepName: "review",
    traceId: "trace-1",
    prompt: "implement feature",
    onRoundComplete: async () => {},
  });

  assert.equal(result.finalStatus, "approved");
  assert.deepEqual(calls, ["generate@1", "review@1", "generate@2", "review@2"]);
  assert.equal(state.stepResults.generate.round, 2);
  assert.equal(state.stepResults.review.round, 2);
  assert.equal(state.approved, true);
  assert.equal(state.stepResults.generate.observation?.status, "success");
  assert.equal(state.stepResults.generate.observation?.schemaVersion, 1);
  assert.equal(state.stepResults.generate.observation?.artifactRefs[0]?.artifactId, "generate:code:0");
  assert.equal(state.stepResults.generate.observation?.artifactRefs[0]?.stepName, "generate");
  assert.equal(state.stepResults.generate.observation?.artifactRefs[0]?.artifactIndex, 0);
  assert.equal(state.stepResults.generate.observation?.artifactRefs[0]?.ref, "stepResults.generate.artifacts[0]");
  assert.ok(state.stepResults.generate.artifacts?.length);
  assert.equal(state.stepResults.generate.artifacts?.[0]?.artifactId, "generate:code:0");
  assert.ok(isCodeArtifact(state.stepResults.generate.artifacts![0]!));
});

test("runPipelineDAGLoop resume reruns failed step without rerunning successful upstream step", async () => {
  const calls: string[] = [];
  const stepRunner = {
    async executeStep(stepName: string, ctx: SchedulerContext): Promise<StepOutcome> {
      calls.push(`${stepName}@${ctx.round}`);
      return {
        stepName,
        usedProvider: "mock",
        upgraded: false,
        routedFrom: undefined,
        durationMs: 1,
        trace: makeTrace(stepName, ctx.round),
        response: {
          kind: "text",
          content: "VERDICT: APPROVED",
          code: "",
          explanation: "",
          model: "mock",
        },
        verdict: { approved: true, feedback: "" },
      };
    },
  } as const;

  const state = {
    stepResults: {
      generate: {
        round: 1,
        status: "success",
        provider: "mock",
        candidateSnapshot: { code: "generated-1", isAgent: false },
      },
      review: {
        round: 1,
        status: "failed",
        provider: "mock",
        error: "review crashed",
      },
    } as Record<string, StepResult>,
    stepTraces: [],
    globalKnowledge: {},
    candidate: { code: "generated-1", isAgent: false },
    approved: false,
    lastReviewFeedback: "",
  };

  const result = await runPipelineDAGLoop({
    runtimeConfig: makeConfig(),
    stepRunner: stepRunner as never,
    costTracker: new CostTracker(),
    state,
    pipelineSessionId: "session-2",
    startRound: 1,
    maxRounds: 1,
    reviewStepName: "review",
    traceId: "trace-2",
    prompt: "resume failed review",
    onRoundComplete: async () => {},
  });

  assert.equal(result.finalStatus, "approved");
  assert.deepEqual(calls, ["review@1"]);
  assert.equal(state.stepResults.generate.round, 1);
  assert.equal(state.stepResults.review.status, "success");
});
