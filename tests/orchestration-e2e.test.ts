/**
 * Phase 6.2 — orchestration integration (mock provider + durable CP).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runPipelineExecution } from "../src/orchestration/pipeline-execution.ts";
import { CostTracker } from "../src/routing/pricing.ts";
import { emptyCandidate } from "../src/core/candidate.ts";
import { createControlPlane } from "../src/orchestration/control-plane.ts";
import type { PipelineConfig } from "../src/core/config.ts";

function workflowConfig(): PipelineConfig {
  return {
    providers: { mock: { type: "mock" } },
    pipeline: {
      alpha: ["mock"],
      beta: ["mock"],
      review: ["mock", "alpha", "beta"],
    },
    retry: { maxRounds: 1, reviewStep: "review" },
    orchestration: { mode: "workflow", conflictResolution: "auto-merge" },
    runtime: { controlPlane: "file" },
  };
}

test("6.2 workflow orchestrator path completes with parallel wave", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-e2e-"));
  try {
    const config = workflowConfig();
    const controlPlane = createControlPlane(config, dir);
    const state = {
      stepResults: {},
      stepTraces: [],
      globalKnowledge: {},
      candidate: emptyCandidate(),
      approved: false,
      lastReviewFeedback: "",
    };

    const result = await runPipelineExecution({
      runtimeConfig: config,
      costTracker: new CostTracker(),
      state,
      pipelineSessionId: "sess-wf",
      startRound: 1,
      maxRounds: 1,
      reviewStepName: "review",
      traceId: "trace-wf",
      prompt: "implement",
      runStore: controlPlane.runStore,
      eventLog: controlPlane.eventLog,
      onRoundComplete: async () => {},
    });

    assert.equal(result.finalStatus, "approved");
    assert.ok(state.stepResults.alpha);
    assert.ok(state.stepResults.beta);
    const events = controlPlane.eventLog.replay("trace-wf");
    assert.ok(events.some((e) => e.event.type === "agent_registered"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("6.2 crash recovery: run store survives restart mid-run", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-crash-"));
  try {
    const config = workflowConfig();
    const cp1 = createControlPlane(config, dir);
    cp1.runStore.save({
      runId: "trace-crash",
      sessionId: "sess",
      status: "running",
      round: 1,
      messageCursor: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      resumeToken: "tok",
    });
    const cp2 = createControlPlane(config, dir);
    const reloaded = cp2.runStore.load("trace-crash");
    assert.equal(reloaded?.resumeToken, "tok");
    assert.equal(reloaded?.status, "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
