import assert from "node:assert/strict";
import test from "node:test";
import { emptyCandidate } from "../../src/core/candidate.ts";
import type { PipelineConfig } from "../../src/core/config.ts";
import { runPipelineExecution } from "../../src/orchestration/pipeline-execution.ts";
import { CostTracker } from "../../src/routing/pricing.ts";
import type { StepResult } from "../../src/core/state.ts";
import type { SchedulerContext, StepOutcome } from "../../src/orchestration/step-execution.ts";

function makeConfig(): PipelineConfig {
  return {
    providers: { mock: { type: "mock" } },
    pipeline: {
      generate: ["mock"],
      review: ["mock", "generate"],
    },
    retry: { maxRounds: 1, reviewStep: "review" },
  };
}

function makeTrace(stepName: string, round: number) {
  return { name: stepName, provider: "mock", durationMs: 1, round };
}

function buildMockScheduler(calls: string[]) {
  return {
    async executeStep(stepName: string, ctx: SchedulerContext): Promise<StepOutcome> {
      calls.push(`${stepName}@${ctx.round}`);
      if (stepName === "generate") {
        return {
          stepName,
          usedProvider: "mock",
          upgraded: false,
          routedFrom: undefined,
          durationMs: 1,
          trace: makeTrace(stepName, ctx.round),
          response: {
            kind: "text",
            content: "code",
            code: "code",
            explanation: "",
            model: "mock",
          },
          candidateSnapshot: { code: "code", isAgent: false },
        };
      }
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
}

test("runPipelineExecution runs generate→review with AgentRegistry bootstrap", async () => {
  const calls: string[] = [];
  const mockScheduler = buildMockScheduler(calls);
  const stepRunner = {
    executeStep: (stepName: string, ctx: SchedulerContext) =>
      mockScheduler.executeStep(stepName, ctx),
  };
  const state = {
    stepResults: {} as Record<string, StepResult>,
    stepTraces: [],
    globalKnowledge: {},
    candidate: emptyCandidate(),
    approved: false,
    lastReviewFeedback: "",
  };

  const result = await runPipelineExecution({
    runtimeConfig: makeConfig(),
    stepRunner: stepRunner as never,
    costTracker: new CostTracker(),
    state,
    pipelineSessionId: "sess",
    startRound: 1,
    maxRounds: 1,
    reviewStepName: "review",
    traceId: "trace",
    prompt: "p",
    onRoundComplete: async () => {},
  });

  assert.deepEqual(calls, ["generate@1", "review@1"]);
  assert.deepEqual(
    state.stepTraces.map((t) => t.name),
    ["generate", "review"],
  );
  assert.equal(result.finalStatus, "approved");
  assert.equal(result.completedRounds, 1);
});
