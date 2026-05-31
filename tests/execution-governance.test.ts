import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyCandidate } from "../src/core/candidate.ts";
import type { PipelineConfig } from "../src/core/config.ts";
import { agentId } from "../src/orchestration/multi-agent-types.ts";
import { FileRunStore } from "../src/orchestration/durable-run-store.ts";
import {
  createExecutionGovernance,
  PolicyDenialError,
} from "../src/orchestration/execution-governance.ts";
import { TripwireError } from "../src/orchestration/guardrails.ts";
import { runPipelineDAGLoop } from "../src/orchestration/pipeline-runner.ts";
import { CostTracker } from "../src/routing/pricing.ts";
import type { StepResult } from "../src/core/state.ts";
import type { SchedulerContext, StepOutcome } from "../src/orchestration/step-execution.ts";

const A = agentId("generate");

function governanceConfig(overrides: Partial<PipelineConfig["runtime"]> = {}): PipelineConfig {
  return {
    providers: { mock: { type: "mock" } },
    pipeline: { generate: ["mock"], review: ["mock", "generate"] },
    retry: { maxRounds: 1, reviewStep: "review" },
    runtime: {
      governance: {
        enabled: true,
        rules: [{ name: "deny-secret", pathPrefix: "/secrets/", decision: "deny" }],
        maxStepExecutionsPerStep: 2,
        approvalMode: "defer",
        ...overrides?.governance,
      },
      controlPlane: "file",
      ...overrides,
    },
  };
}

test("PolicyDenialError blocks step before scheduler", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-gov-"));
  try {
    const config = governanceConfig();
    const store = new FileRunStore(join(dir, "runs"));
    const governance = createExecutionGovernance(config, { runStore: store, runId: "run-1" })!;

    await assert.rejects(
      () =>
        governance.beforeStep({
          agentId: A,
          role: "worker",
          task: { stepName: "generate", prompt: "x", round: 1, sessionId: "s" },
          action: "execute_step",
          targetPath: "/secrets/key.txt",
        }),
      PolicyDenialError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defer approval pauses pipeline with awaiting_approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-gov-defer-"));
  try {
    const config = governanceConfig({
      governance: {
        enabled: true,
        defaultPolicy: "require-approval",
        approvalMode: "defer",
      },
    });
    const store = new FileRunStore(join(dir, "runs"));
    store.save({
      runId: "trace-defer",
      status: "running",
      sessionId: "sess",
      round: 1,
      messageCursor: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const governance = createExecutionGovernance(config, { runStore: store, runId: "trace-defer" })!;

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

    const state = {
      stepResults: {} as Record<string, StepResult>,
      stepTraces: [],
      globalKnowledge: {},
      candidate: emptyCandidate(),
      approved: false,
      lastReviewFeedback: "",
    };

    const result = await runPipelineDAGLoop({
      runtimeConfig: config,
      stepRunner: scheduler as never,
      costTracker: new CostTracker(),
      governance,
      state,
      pipelineSessionId: "sess",
      startRound: 1,
      maxRounds: 1,
      reviewStepName: "review",
      traceId: "trace-defer",
      prompt: "p",
      onRoundComplete: async () => {},
    });

    assert.equal(result.finalStatus, "awaiting_approval");
    assert.equal(store.load("trace-defer")?.status, "awaiting_approval");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LoopDetectionGuardrail trips on repeated step executions", async () => {
  const config = governanceConfig({
    governance: { enabled: true, maxStepExecutionsPerStep: 1, rules: [] },
  });
  const governance = createExecutionGovernance(config)!;
  const task = { stepName: "generate", prompt: "p", round: 1, sessionId: "s" };

  await governance.beforeStep({ agentId: A, role: "worker", task, action: "execute_step" });
  await assert.rejects(
    () => governance.beforeStep({ agentId: A, role: "worker", task, action: "execute_step" }),
      TripwireError,
  );
});
