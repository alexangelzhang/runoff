import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { routeProvider, estimateComplexity } from "../src/router.js";

test("Wave 6: Dynamic Routing & Self-Optimization (Step 5)", async (t) => {
  const previousHome = process.env.LLM_PIPELINE_HOME;
  const sandboxHome = join(tmpdir(), ".llm-pipeline-test-" + Math.random().toString(36).slice(2, 8));
  process.env.LLM_PIPELINE_HOME = sandboxHome;

  const tracesDir = join(sandboxHome, "traces");
  const testTraceFile = join(tracesDir, "test_failure_bias.json");

  // Setup: Create a fake trace that heavily biases against "bad-provider"
  if (!existsSync(tracesDir)) mkdirSync(tracesDir, { recursive: true });
  
  const fakeTrace = {
    id: "t1",
    prompt: "complex task",
    promptLength: 100,
    mode: "pipeline",
    steps: [
      { name: "gen", provider: "bad-provider", durationMs: 1000, round: 1, error: "Failed badly" },
      { name: "gen", provider: "bad-provider", durationMs: 1000, round: 2, error: "Failed again" }
    ],
    totalRounds: 2,
    finalStatus: "failed",
    totalDurationMs: 2000,
    timestamp: new Date().toISOString(),
    hasVerifyResults: false
  };
  
  writeFileSync(testTraceFile, JSON.stringify(fakeTrace));

  await t.test("Complexity Estimation still works", () => {
    const hints = estimateComplexity("Design a distributed lock system with high availability.");
    assert.equal(hints.complexity, "high", "Architecture keywords should trigger high complexity");
  });

  await t.test("Tie-breaker should avoid provider with high failure rate", () => {
    const rules = [
      { complexity: "high", provider: "bad-provider" },
      { complexity: "high", provider: "good-provider" }
    ] as any;

    // We expect "good-provider" to be chosen even if "bad-provider" is first in list,
    // because its success rate is simulated to be 1.0 (no traces) vs bad-provider's 0.0
    const chosen = routeProvider(
      "Design architecture for scale",
      rules,
      "default"
    );

    assert.equal(chosen, "good-provider", "Dynamic routing should penalize failing provider");
  });

  // Cleanup
  if (existsSync(testTraceFile)) rmSync(testTraceFile);
  if (previousHome === undefined) delete process.env.LLM_PIPELINE_HOME;
  else process.env.LLM_PIPELINE_HOME = previousHome;
});
