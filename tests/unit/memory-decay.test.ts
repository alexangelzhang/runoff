import assert from "node:assert/strict";
import test from "node:test";
import {
  decayedRelevance,
  DEFAULT_MEMORY_HALF_LIFE_MS,
  memoryDecayLambda,
} from "../../src/orchestration/memory-decay.ts";

test("decayedRelevance halves at default half-life", () => {
  const lambda = memoryDecayLambda(DEFAULT_MEMORY_HALF_LIFE_MS);
  const half = decayedRelevance(1, DEFAULT_MEMORY_HALF_LIFE_MS, lambda);
  assert.ok(Math.abs(half - 0.5) < 0.001);
});

test("decayedRelevance decreases with age", () => {
  const young = decayedRelevance(1, 0);
  const old = decayedRelevance(1, DEFAULT_MEMORY_HALF_LIFE_MS * 2);
  assert.ok(young > old);
  assert.ok(old < young * 0.3);
});
