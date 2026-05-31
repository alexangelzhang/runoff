import assert from "node:assert/strict";
import test from "node:test";
import {
  CostBudgetExceededError,
  CostGovernor,
  recordPipelineStepCost,
} from "../src/routing/pricing.ts";

test("CostGovernor aborts when budget exceeded", () => {
  const governor = new CostGovernor(0.000001);
  assert.throws(
    () => {
      governor.addCall("s1", "p", "gpt-4o", { promptTokens: 100_000, completionTokens: 100_000 });
    },
    CostBudgetExceededError,
  );
});

test("recordPipelineStepCost enforces governor budget", () => {
  const governor = new CostGovernor(0.000001);
  assert.throws(
    () => {
      recordPipelineStepCost(governor, "s1", "p", "gpt-4o", {
        promptTokens: 50_000,
        completionTokens: 50_000,
      });
    },
    CostBudgetExceededError,
  );
});
