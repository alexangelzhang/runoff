import assert from "node:assert/strict";
import test from "node:test";
import { emptyCandidate } from "../../src/core/candidate.ts";
import type { PipelineConfig } from "../../src/core/config.ts";
import { runPipelineDAGLoop } from "../../src/orchestration/pipeline-runner.ts";
import { DAGOrchestrator } from "../../src/orchestration/orchestrator.ts";
import { CostTracker } from "../../src/routing/pricing.ts";
import type { StepResult } from "../../src/core/state.ts";
import type { SchedulerContext, StepOutcome } from "../../src/orchestration/step-execution.ts";
import { artifactsFromStepResponse } from "../../src/orchestration/artifact-bridge.ts";
import { isCodeArtifact } from "../../src/orchestration/artifacts.ts";
import { applyResumeStepReusePlan } from "../../src/orchestration/pipeline-runner-helpers.ts";
import { agentId } from "../../src/orchestration/multi-agent-types.ts";

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

test("runPipelineDAGLoop with DAGOrchestrator retries after review NEEDS_REVISION", async () => {
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

  const steps = ["generate", "review"];
  const result = await runPipelineDAGLoop({
    runtimeConfig: makeConfig(),
    stepRunner: stepRunner as never,
    costTracker: new CostTracker(),
    state,
    pipelineSessionId: "session-dag-orch",
    startRound: 1,
    maxRounds: 2,
    reviewStepName: "review",
    traceId: "trace-dag-orch",
    prompt: "implement feature",
    onRoundComplete: async () => {},
    orchestrator: new DAGOrchestrator(makeConfig().pipeline, 2),
    orchestrationContext: {
      runId: "run-dag-orch",
      sessionId: "session-dag-orch",
      steps,
      assignments: new Map(steps.map((s) => [s, agentId(s)])),
      results: new Map(),
      round: 1,
      sharedKnowledge: {},
    },
  });

  assert.equal(result.finalStatus, "approved");
  assert.deepEqual(calls, ["generate@1", "review@1", "generate@2", "review@2"]);
  assert.equal(state.approved, true);
  assert.equal(state.lastReviewFeedback, "");
});

test("runPipelineDAGLoop honors orchestrator retry for failed step on next round", async () => {
  const calls: string[] = [];
  const completions: string[] = [];
  const orchestrator = {
    async onStepComplete(_context: unknown, result: { stepName: string }) {
      completions.push(result.stepName);
      return { type: "done" as const, success: true };
    },
    async onStepFailed() {
      return { type: "retry" as const, stepName: "generate" };
    },
  };
  const stepRunner = {
    async executeStep(stepName: string, ctx: SchedulerContext): Promise<StepOutcome> {
      calls.push(`${stepName}@${ctx.round}`);
      if (ctx.round === 1) {
        return {
          stepName,
          usedProvider: "mock",
          upgraded: false,
          routedFrom: undefined,
          durationMs: 1,
          trace: makeTrace(stepName, ctx.round),
          response: {
            kind: "text",
            content: "",
            code: "",
            explanation: "",
            model: "mock",
            failed: true,
            error: "transient",
          },
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
          content: "ok",
          code: "ok",
          explanation: "",
          model: "mock",
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
    runtimeConfig: {
      providers: { mock: { type: "mock" } },
      pipeline: { generate: ["mock"] },
      retry: { maxRounds: 2, reviewStep: "review" },
    },
    stepRunner: stepRunner as never,
    costTracker: new CostTracker(),
    state,
    pipelineSessionId: "session-retry-failed",
    startRound: 1,
    maxRounds: 2,
    reviewStepName: "review",
    traceId: "trace-retry-failed",
    prompt: "implement feature",
    onRoundComplete: async () => {},
    orchestrator: orchestrator as never,
    orchestrationContext: {
      runId: "run-retry-failed",
      sessionId: "session-retry-failed",
      steps: ["generate"],
      assignments: new Map([["generate", agentId("generate")]]),
      results: new Map(),
      round: 1,
      sharedKnowledge: {},
    },
  });

  assert.equal(result.finalStatus, "approved");
  assert.deepEqual(calls, ["generate@1", "generate@2"]);
  assert.deepEqual(completions, ["generate"]);
  assert.equal(state.stepResults.generate.status, "success");
  assert.equal(state.lastRetryFailure, undefined);
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

test("runPipelineDAGLoop resume reruns incomplete success and downstream completed steps", async () => {
  const calls: string[] = [];
  const stepRunner = {
    async executeStep(stepName: string, ctx: SchedulerContext): Promise<StepOutcome> {
      calls.push(`${stepName}@${ctx.round}`);
      const response = {
        kind: "text" as const,
        content: stepName === "review" ? "VERDICT: APPROVED" : `${stepName}-${ctx.round}`,
        code: `${stepName}-${ctx.round}`,
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
        candidateSnapshot: stepName === "review" ? undefined : { code: `${stepName}-${ctx.round}`, isAgent: false },
        verdict: stepName === "review" ? { approved: true, feedback: "" } : undefined,
        artifacts: artifactsFromStepResponse(response, { stepName }),
      };
    },
  } as const;

  const state = {
    stepResults: {
      generate: {
        round: 1,
        status: "success",
        provider: "mock",
        kind: "text",
        code: "stale",
        candidateSnapshot: { code: "stale", isAgent: false },
        resumeMetadata: {
          schemaVersion: 1,
          stepName: "generate",
          round: 1,
          inputHash: "hash-generate",
          artifactCompleteness: "partial",
          providerResultPresent: true,
          workspaceAttachment: "none",
          canSkipOnResume: false,
          evidenceRefs: ["stepResults.generate.status"],
          mustRerunReason: "artifact completeness is partial",
        },
      },
      review: {
        round: 1,
        status: "success",
        provider: "mock",
        kind: "text",
        code: "VERDICT: APPROVED",
        resumeMetadata: {
          schemaVersion: 1,
          stepName: "review",
          round: 1,
          inputHash: "hash-review",
          artifactCompleteness: "complete",
          providerResultPresent: true,
          workspaceAttachment: "none",
          canSkipOnResume: true,
          evidenceRefs: ["stepResults.review.status"],
        },
      },
    } as Record<string, StepResult>,
    stepTraces: [],
    globalKnowledge: {},
    candidate: { code: "stale", isAgent: false },
    approved: false,
    lastReviewFeedback: "",
  };

  const result = await runPipelineDAGLoop({
    runtimeConfig: makeConfig(),
    stepRunner: stepRunner as never,
    costTracker: new CostTracker(),
    state,
    pipelineSessionId: "session-3",
    startRound: 1,
    maxRounds: 1,
    reviewStepName: "review",
    traceId: "trace-3",
    prompt: "resume incomplete generate",
    onRoundComplete: async () => {},
  });

  assert.equal(result.finalStatus, "approved");
  assert.deepEqual(calls, ["generate@1", "review@1"]);
  assert.equal(state.stepResults.generate.status, "success");
  assert.equal(state.stepResults.review.status, "success");
  assert.equal(state.stepResults.generate.resumeMetadata?.canSkipOnResume, true);
  assert.equal(state.stepResults.review.resumeMetadata?.canSkipOnResume, true);
  assert.match(state.stepResults.generate.resumeMetadata?.rerunReason ?? "", /artifact completeness is partial/);
  assert.match(state.stepResults.review.resumeMetadata?.rerunReason ?? "", /downstream dependency generate/);
  assert.equal(result.resumeReusePlan?.summary.rerun, 2);
  assert.equal(state.resumeReusePlan?.summary.skipped, 0);
  assert.deepEqual(
    result.resumeReusePlan?.entries.map((entry) => [entry.stepName, entry.decision]),
    [
      ["generate", "rerun"],
      ["review", "rerun"],
    ],
  );
  assert.equal(
    result.resumeReusePlan?.entries.find((entry) => entry.stepName === "review")?.downstreamOf,
    "generate",
  );
});

test("applyResumeStepReusePlan keeps legacy completed results skippable", () => {
  const stepResults = {
    generate: {
      round: 1,
      status: "success",
      provider: "mock",
    },
    review: {
      round: 1,
      status: "success",
      provider: "mock",
      resumeMetadata: {
        schemaVersion: 1,
        stepName: "review",
        round: 1,
        inputHash: "hash-review",
        artifactCompleteness: "complete",
        providerResultPresent: true,
        workspaceAttachment: "none",
        canSkipOnResume: true,
        evidenceRefs: ["stepResults.review.status"],
      },
    },
  } as Record<string, StepResult>;

  const plan = applyResumeStepReusePlan({
    stepResults,
    pipeline: makeConfig().pipeline,
    round: 1,
  });

  assert.deepEqual(plan.rerunSteps, []);
  assert.equal(stepResults.generate.status, "success");
  assert.equal(stepResults.review.status, "success");
  assert.ok(plan.skippedSteps.some((step) => step.stepName === "generate"));
  assert.ok(plan.skippedSteps.some((step) => step.stepName === "review"));
  assert.deepEqual(plan.report.summary, { skipped: 2, rerun: 0 });
  assert.ok(plan.report.entries.every((entry) => entry.decision === "skipped"));
});

test("applyResumeStepReusePlan does not report invalidated downstream as skipped", () => {
  const stepResults = {
    generate: {
      round: 1,
      status: "success",
      provider: "mock",
      resumeMetadata: {
        schemaVersion: 1,
        stepName: "generate",
        round: 1,
        inputHash: "hash-generate",
        artifactCompleteness: "partial",
        providerResultPresent: true,
        workspaceAttachment: "none",
        canSkipOnResume: false,
        evidenceRefs: ["stepResults.generate.status"],
        mustRerunReason: "artifact completeness is partial",
      },
    },
    review: {
      round: 1,
      status: "success",
      provider: "mock",
      resumeMetadata: {
        schemaVersion: 1,
        stepName: "review",
        round: 1,
        inputHash: "hash-review",
        artifactCompleteness: "complete",
        providerResultPresent: true,
        workspaceAttachment: "none",
        canSkipOnResume: true,
        evidenceRefs: ["stepResults.review.status"],
      },
    },
  } as Record<string, StepResult>;

  const plan = applyResumeStepReusePlan({
    stepResults,
    pipeline: makeConfig().pipeline,
    round: 1,
  });

  assert.deepEqual(
    plan.rerunSteps.map((step) => step.stepName),
    ["generate", "review"],
  );
  assert.deepEqual(plan.skippedSteps, []);
  assert.deepEqual(plan.report.summary, { skipped: 0, rerun: 2 });
  assert.equal(plan.report.entries.find((entry) => entry.stepName === "review")?.downstreamOf, "generate");
});
