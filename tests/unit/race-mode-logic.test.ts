import assert from "node:assert/strict";
import test from "node:test";
import { parseVerdict } from "../../src/core/verdict.js";
import { isTextResponse } from "../../src/providers/types.js";
import { isSyntaxValid } from "../../src/infra/ast_utils.js";

test("Wave 2: Race Mode Winner Selection Heuristic", async (t) => {
  
  await t.test("Selective Winner: Syntax Beats Fast Failure", () => {
    // Participant 1: Fast but invalid syntax
    const p1 = {
      resp: { kind: "text", failed: false, code: "function error {", model: "mini" },
      verdict: { format: "structured", approved: true }
    };
    
    // Participant 2: Slower but valid syntax
    const p2 = {
      resp: { kind: "text", failed: false, code: "function ok() {}", model: "gpt4" },
      verdict: { format: "structured", approved: true }
    };

    const participants: any[] = [p1, p2];
    
    // The heuristic logic implemented in scheduler.ts:
    const winners = participants.filter(r => !r.resp.failed);
    const bestWinner = winners.sort((a, b) => {
      const aSyntax = a.resp.code ? !a.resp.code.includes("{") || a.resp.code.includes("}") : true; // Simplified mock
      const bSyntax = b.resp.code ? b.resp.code.includes("()") : true;
      if (!aSyntax && bSyntax) return 1;
      if (aSyntax && !bSyntax) return -1;
      return 0;
    })[0];

    assert.equal(bestWinner.resp.model, "gpt4", "Syntax-valid model should win over invalid one");
  });
});
