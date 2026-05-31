import assert from "node:assert/strict";
import test from "node:test";
import {
  compareRegression,
  evaluatePipelineTrace,
} from "../../src/orchestration/harness.ts";
import type { PipelineTrace } from "../../src/observability/trace.ts";

function trace(overrides: Partial<PipelineTrace> = {}): PipelineTrace {
  return {
    id: "t1",
    prompt: "p",
    promptLength: 1,
    mode: "pipeline",
    steps: [{ name: "a", provider: "mock", durationMs: 1, round: 1 }],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 5000,
    hasVerifyResults: false,
    timestamp: new Date().toISOString(),
    approvals: [{ requestId: "r1", agentId: "w", action: "x", decision: "approve", respondedAt: 1 }],
    ...overrides,
  };
}

test("evaluatePipelineTrace scores success and counts", () => {
  const result = evaluatePipelineTrace(trace());
  assert.equal(result.success, true);
  assert.equal(result.stepCount, 1);
  assert.equal(result.approvalCount, 1);
});

test("compareRegression fails on success mismatch", () => {
  const baseline = evaluatePipelineTrace(trace());
  const actual = evaluatePipelineTrace(trace({ finalStatus: "failed" }));
  const cmp = compareRegression(actual, baseline);
  assert.equal(cmp.pass, false);
  assert.match(cmp.message ?? "", /success mismatch/);
});

test("compareRegression allows duration within tolerance", () => {
  const baseline = evaluatePipelineTrace(trace({ totalDurationMs: 1000 }));
  const actual = evaluatePipelineTrace(trace({ totalDurationMs: 1500 }));
  assert.equal(compareRegression(actual, baseline, { maxDurationDeltaMs: 1000 }).pass, true);
});
