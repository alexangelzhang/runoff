import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewPrompt, buildGeneratePrompt } from "../src/pipeline/prompt.js";
import { runPipelineMode } from "../src/tools/run-pipeline.js";

test("Wave 6: Semantic Blackboard (Step 1 Foundations)", async (t) => {
  
  await t.test("Prompt builder should include Shared Knowledge in Static Context", () => {
    const knowledge = { "arch_standard": "Use hexagonal architecture" };
    const prompt = buildGeneratePrompt({
      spec: "Create a user service",
      round: 1,
      knowledge
    });

    assert.ok(prompt.staticContext.includes("## Shared Knowledge"), "Static context should have knowledge header");
    assert.ok(prompt.staticContext.includes("arch_standard"), "Key should be present");
    assert.ok(prompt.staticContext.includes("hexagonal architecture"), "Value should be present");
  });

  await t.test("Review prompt should also include Shared Knowledge", () => {
    const knowledge = { "risk": "Avoid circular dependencies in UI" };
    const prompt = buildReviewPrompt({
      spec: "Review UI code",
      candidateContent: "export const A = {}",
      candidateLabel: "Code",
      knowledge
    });

    assert.ok(prompt.staticContext.includes("## Shared Knowledge"), "Review static context should have knowledge");
    assert.ok(prompt.staticContext.includes("Avoid circular dependencies"), "Risk insight should be present");
  });
});
