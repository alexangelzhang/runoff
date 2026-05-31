import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAgentMemory } from "../../src/orchestration/memory.ts";
import {
  contentSimilarity,
  mergeMemoryEntries,
} from "../../src/orchestration/memory-merge.ts";
import { agentId } from "../../src/orchestration/multi-agent-types.ts";

test("contentSimilarity: near-duplicate prompts score high", () => {
  const a = "refactor async handler for user login flow";
  const b = "refactor async handler for user login flow extra";
  assert.ok(contentSimilarity(a, b) >= 0.8);
});

test("mergeMemoryEntries: merges same category similar content", () => {
  const scope = { project: "p1" };
  const base = {
    agentId: agentId("worker"),
    scope,
    category: "pattern" as const,
    metadata: {},
  };
  const entries = [
    {
      ...base,
      id: "mem-1",
      content: "promptHash:abc refactor login async handler step one",
      relevance: 0.9,
      createdAt: 1,
      lastAccessedAt: 1,
    },
    {
      ...base,
      id: "mem-2",
      content: "promptHash:abc refactor login async handler step one done",
      relevance: 0.8,
      createdAt: 2,
      lastAccessedAt: 2,
    },
  ];

  const { entries: merged, mergedCount, removedIds } = mergeMemoryEntries(entries);
  assert.equal(merged.length, 1);
  assert.equal(mergedCount, 1);
  assert.deepEqual(removedIds, ["mem-2"]);
});

test("InMemoryAgentMemory.compact reduces duplicate entries", () => {
  const mem = new InMemoryAgentMemory();
  const scope = { project: "test" };
  mem.store({
    agentId: agentId("a"),
    scope,
    category: "lesson",
    content: "always run tests before commit",
    metadata: {},
  });
  mem.store({
    agentId: agentId("a"),
    scope,
    category: "lesson",
    content: "always run tests before commit",
    metadata: { source: "b" },
  });
  assert.equal(mem.size, 2);
  const removed = mem.compact({ minSimilarity: 0.95 });
  assert.equal(removed, 1);
  assert.equal(mem.size, 1);
});
