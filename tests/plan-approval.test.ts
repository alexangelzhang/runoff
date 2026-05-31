import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyCandidate } from "../src/core/candidate.ts";
import type { PipelineConfig } from "../src/core/config.ts";
import { FileRunStore } from "../src/orchestration/durable-run-store.ts";
import { runPipelineExecution } from "../src/orchestration/pipeline-execution.ts";
import { resumePlanAfterApproval } from "../src/orchestration/plan-control.ts";
import { CostTracker } from "../src/routing/pricing.ts";
import type { StepResult } from "../src/core/state.ts";
import type { SchedulerContext, StepOutcome } from "../src/orchestration/step-execution.ts";

test("plan approval defer pauses before DAG loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-plan-"));
  try {
    const config: PipelineConfig = {
      providers: { mock: { type: "mock" } },
      pipeline: { generate: ["mock"], review: ["mock", "generate"] },
      retry: { maxRounds: 1, reviewStep: "review" },
      runtime: {
        governance: { enabled: true, requirePlanApproval: true, approvalMode: "defer" },
      },
    };
    const store = new FileRunStore(join(dir, "runs"));
    store.save({
      runId: "trace-plan",
      status: "running",
      sessionId: "sess",
      round: 1,
      messageCursor: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const scheduler = {
      async executeStep(stepName: string, ctx: SchedulerContext): Promise<StepOutcome> {
        return {
          stepName,
          usedProvider: "mock",
          upgraded: false,
          durationMs: 1,
          trace: { name: stepName, provider: "mock", durationMs: 1, round: ctx.round },
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

    const result = await runPipelineExecution({
      runtimeConfig: config,
      stepRunner: scheduler as never,
      costTracker: new CostTracker(),
      runStore: store,
      state: {
        stepResults: {} as Record<string, StepResult>,
        stepTraces: [],
        globalKnowledge: {},
        candidate: emptyCandidate(),
        approved: false,
        lastReviewFeedback: "",
      },
      pipelineSessionId: "sess",
      startRound: 1,
      maxRounds: 1,
      traceId: "trace-plan",
      prompt: "p",
      onRoundComplete: async () => {},
    });

    assert.equal(result.finalStatus, "awaiting_plan_approval");
    assert.ok(result.pendingExecutionPlan);
    assert.equal(store.load("trace-plan")?.metadata?.approvalPhase, "plan");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resumePlanAfterApproval allows continuation", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-plan-resume-"));
  try {
    const store = new FileRunStore(join(dir, "runs"));
    store.save({
      runId: "r1",
      status: "awaiting_approval",
      sessionId: "s",
      round: 1,
      messageCursor: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: { approvalPhase: "plan", executionPlan: { steps: ["a", "b"] } },
      pendingApproval: {
        agentId: "orchestrator",
        action: "execute_plan",
        description: "plan",
        requestedAt: Date.now(),
      },
    });
    const updated = resumePlanAfterApproval(store, "r1", { decision: "approve" });
    assert.equal(updated?.metadata?.planApproved, true);
    assert.equal(updated?.status, "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
