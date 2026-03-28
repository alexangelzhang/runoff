import assert from "node:assert/strict";
import test from "node:test";
import { parseVerdict } from "../src/verdict.js";
import { LLMProvider, LLMRequest, LLMResponse, isTextResponse } from "../src/providers/types.js";

test("Resilience: Format Correction Loop (Step 3 Foundations)", async (t) => {
  
  await t.test("parseVerdict should identify unstructured output", () => {
    const raw = "I think this code is great, I like the way you did it. APPROVED.";
    const result = parseVerdict(raw);
    assert.equal(result.format, "unstructured", "Loose sentence should be unstructured");
    assert.equal(result.approved, false, "Fallback to not approved if unstructured");
  });

  await t.test("parseVerdict should identify structured sentinel", () => {
    const raw = "Review done.\nVERDICT: APPROVED";
    const result = parseVerdict(raw);
    assert.equal(result.format, "structured", "Sentinel should be structured");
    assert.equal(result.approved, true, "Should be approved");
  });

  // Mocking the correction flow (Conceptual unit test for the logic in scheduler.ts)
  await t.test("Orchestrator should detect failure and suggest correction", async () => {
    let callCount = 0;
    const mockProvider: LLMProvider = {
      name: "mock-llm",
      mode: "text",
      execute: async (req: LLMRequest): Promise<LLMResponse> => {
        callCount++;
        if (callCount === 1) {
          // First call: Malformed
          return {
            kind: "text",
            model: "mock",
            content: "Well, let me see... it looks okay but wait...",
            code: "",
            explanation: ""
          };
        }
        // Second call: Prompted by Format Correction Loop
        if (req.system?.includes("formatting assistant")) {
          return {
            kind: "text",
            model: "mock",
            content: "VERDICT: APPROVED",
            code: "",
            explanation: ""
          };
        }
        return { kind: "text", model: "mock", content: "FAIL", code: "", explanation: "" };
      }
    };

    // Simulate the loop logic now inside scheduler.ts:
    const firstResponse = await mockProvider.execute({ prompt: "review", round: 1 });
    const firstRaw = isTextResponse(firstResponse) ? firstResponse.content : "";
    const firstVerdict = parseVerdict(firstRaw);
    
    assert.equal(firstVerdict.format, "unstructured");
    
    // Simulate the loop logic inside scheduler.ts:
    if (firstVerdict.format === "unstructured") {
      const correctionReq: LLMRequest = {
        prompt: "FIX FORMAT",
        system: "formatting assistant",
        round: 1
      };
      const secondResponse = await mockProvider.execute(correctionReq);
      const secondRaw = isTextResponse(secondResponse) ? secondResponse.content : "";
      const secondVerdict = parseVerdict(secondRaw);
      
      assert.equal(secondVerdict.format, "structured");
      assert.equal(secondVerdict.approved, true);
      assert.equal(callCount, 2, "Should have taken 2 calls to correct format");
    }
  });
});
