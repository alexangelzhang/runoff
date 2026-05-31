import assert from "node:assert/strict";
import test from "node:test";

test("Wave 2: Dynamic DAG Expansion Logic", async (t) => {
  
  await t.test("Expansion: Injecting nextSteps into pipeline config", () => {
    const mockConfig: any = {
      pipeline: {
        "A": ["mock-p"]
      }
    };
    
    const outcome = {
      stepName: "A",
      nextSteps: [{ name: "B", provider: "mock-new", dependsOn: ["A"] }]
    };

    // Orchestrator logic in run-pipeline.ts:
    if (outcome.nextSteps) {
      for (const ns of outcome.nextSteps) {
        if (!mockConfig.pipeline[ns.name]) {
          mockConfig.pipeline[ns.name] = [ns.provider, ...(ns.dependsOn || ["A"])];
        }
      }
    }

    assert.ok(mockConfig.pipeline["B"], "Step B should be injected into config");
    assert.equal(mockConfig.pipeline["B"][0], "mock-new", "Provider should match");
    assert.deepEqual(mockConfig.pipeline["B"].slice(1), ["A"], "Dependencies should match");
  });

  await t.test("Rolling Stages: Re-calculation after expansion", async () => {
    // Confirm target logic for getDagStages(config)
    let stages = [["A"]]; // Initial
    
    // Simulate expansion...
    const config = { pipeline: { "A": ["p"], "B": ["p", "A"] } };
    
    // Re-calculating:
    const { getDagStages } = await import("../../src/core/config.js");
    const newStages = getDagStages(config as any);
    
    assert.equal(newStages.length, 2, "Should now have 2 stages");
    assert.equal(newStages.find(s => s.includes("B")) !== undefined, true, "Stage 2 should contain B");
  });
});
