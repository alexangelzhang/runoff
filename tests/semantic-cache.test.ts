import assert from "node:assert/strict";
import test from "node:test";
import { SemanticResponseCache, clearSemanticCache } from "../src/routing/semantic-cache.ts";
import { ResponseCache } from "../src/routing/cache.ts";
import type { TextResponse } from "../src/providers/types.ts";

function textResponse(content: string): TextResponse {
  return {
    kind: "text",
    model: "mock",
    content,
    code: "",
    explanation: "",
  };
}

test.after(() => clearSemanticCache());

test("SemanticResponseCache: reuses response for paraphrased prompt", () => {
  const cache = new SemanticResponseCache({ minSimilarity: 0.75 });
  const provider = "mock-pro";
  const promptA = "implement fibonacci function in typescript with memo";
  const promptB = "implement fibonacci function in typescript with memoization";
  const keyA = ResponseCache.key(provider, promptA);
  const keyB = ResponseCache.key(provider, promptB);
  const lookupA = { provider, prompt: promptA };
  const lookupB = { provider, prompt: promptB };

  cache.put(keyA, textResponse("code-a"), lookupA);
  assert.equal(cache.get(keyB, lookupB)?.content, "code-a");
  assert.equal(cache.getStats().semanticHits, 1);
});

test("SemanticResponseCache: different provider does not match", () => {
  const cache = new SemanticResponseCache({ minSimilarity: 0.9 });
  const prompt = "same prompt text here for testing";
  const key = ResponseCache.key("mock-a", prompt);
  cache.put(key, textResponse("x"), { provider: "mock-a", prompt });
  const miss = cache.get(ResponseCache.key("mock-b", prompt), {
    provider: "mock-b",
    prompt,
  });
  assert.equal(miss, null);
});
