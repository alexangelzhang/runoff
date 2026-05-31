import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyOrchestratorFailure,
  classifyStepFailure,
  findDowngradedProvider,
  pickRetryProvider,
} from "../../src/routing/retry-strategy.ts";

test("classifyStepFailure: timeout from error message", () => {
  assert.equal(
    classifyStepFailure({ failed: true, error: "Request timed out after 300000ms" }),
    "timeout",
  );
});

test("classifyStepFailure: quality from needs-revision verdict", () => {
  const reason = classifyStepFailure({
    failed: false,
    response: {
      kind: "text",
      model: "mock",
      content: "VERDICT: NEEDS_REVISION\nFeedback: fix types",
      code: "",
      explanation: "",
    },
  });
  assert.equal(reason, "quality");
});

test("pickRetryProvider: timeout downgrades, quality upgrades", () => {
  const providers = {
    fast: { type: "mock" as const, tier: "lite" as const, avgLatencyMs: 100 },
    strong: { type: "mock" as const, tier: "full" as const },
  };
  const all = ["fast", "strong"];
  assert.equal(pickRetryProvider("strong", all, providers, "timeout"), "fast");
  assert.equal(pickRetryProvider("fast", all, providers, "quality"), "strong");
});

test("findDowngradedProvider: prefers lowest avgLatencyMs", () => {
  const providers = {
    a: { type: "mock" as const, tier: "lite" as const, avgLatencyMs: 500 },
    b: { type: "mock" as const, tier: "lite" as const, avgLatencyMs: 50 },
    pro: { type: "mock" as const, tier: "full" as const },
  };
  assert.equal(findDowngradedProvider("pro", ["a", "b", "pro"], providers), "b");
});

test("classifyOrchestratorFailure: maps Error message", () => {
  assert.equal(classifyOrchestratorFailure(new Error("ETIMEDOUT")), "timeout");
});
