import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAgentMemory } from "../src/orchestration/memory.ts";
import {
  cosineSimilarity,
  embedText,
  rankEntriesBySemanticQuery,
} from "../src/orchestration/memory-embedding.ts";
import { feedbackRelevanceFromTrace } from "../src/orchestration/memory-relevance.ts";
import { PatternCache } from "../src/orchestration/pattern-cache.ts";
import { agentId } from "../src/orchestration/multi-agent-types.ts";
import type { PipelineTrace } from "../src/observability/trace.js";
import { hashPrompt } from "../src/orchestration/pattern-cache.ts";

test("embedText: similar strings have high cosine similarity", () => {
  const a = embedText("refactor user authentication module");
  const b = embedText("refactor user authentication service");
  assert.ok(cosineSimilarity(a, b) > 0.5);
});

test("InMemoryAgentMemory: semanticQuery ranks related pattern first", () => {
  const mem = new InMemoryAgentMemory();
  const scope = { project: "sem" };
  const agent = agentId("pattern-cache");

  mem.store({
    agentId: agent,
    scope,
    category: "pattern",
    content: "promptHash:aaa\nbuild rest api for orders",
    metadata: { tag: "orders" },
    relevance: 0.5,
  });
  mem.store({
    agentId: agent,
    scope,
    category: "pattern",
    content: "promptHash:bbb\noptimize database index queries",
    metadata: { tag: "db" },
    relevance: 0.5,
  });

  const hits = mem.retrieve({
    agentId: agent,
    category: "pattern",
    scope,
    semanticQuery: "create rest api for order management",
    minSemanticSimilarity: 0.25,
    limit: 1,
  });

  assert.equal(hits.length, 1);
  assert.match(hits[0]!.content, /rest api for orders/);
});

test("feedbackRelevanceFromTrace: bumps relevance on approval", () => {
  const mem = new InMemoryAgentMemory();
  const scope = { project: "fb" };
  const prompt = "fix login timeout bug";
  const hash = hashPrompt(prompt);
  mem.store({
    agentId: agentId("pattern-cache"),
    scope,
    category: "pattern",
    content: `promptHash:${hash}\n${prompt}`,
    relevance: 0.5,
    metadata: {},
  });
  const beforeRelevance = 0.5;

  const trace: PipelineTrace = {
    id: "t1",
    prompt,
    promptLength: prompt.length,
    mode: "pipeline",
    hasVerifyResults: false,
    steps: [],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 10,
    timestamp: new Date().toISOString(),
    lifecycle: "final",
  };

  const n = feedbackRelevanceFromTrace(mem, trace, scope);
  assert.equal(n, 1);
  const updated = mem.retrieve({
    category: "pattern",
    scope,
    textSearch: `promptHash:${hash}`,
    limit: 1,
  })[0]!;
  assert.ok((updated.relevance ?? 0) > beforeRelevance);
});

test("PatternCache: semantic match without exact hash", () => {
  const mem = new InMemoryAgentMemory();
  const cache = new PatternCache(mem, { project: "sem-cache" });
  const prompt = "implement graphql resolver for user profile";

  const trace: PipelineTrace = {
    id: "t2",
    prompt: "implement graphql resolver for user profile fields",
    promptLength: 50,
    mode: "pipeline",
    hasVerifyResults: false,
    steps: [
      {
        name: "generate",
        provider: "mock",
        durationMs: 1,
        round: 1,
      },
    ],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1,
    timestamp: new Date().toISOString(),
    lifecycle: "final",
  };

  cache.storeFromTrace(trace);
  const patterns = cache.matchPatterns(prompt, 1);
  assert.equal(patterns.length, 1);
  assert.ok(patterns[0]!.providerChain.includes("mock"));
});

test("rankEntriesBySemanticQuery: filters below threshold", () => {
  const ranked = rankEntriesBySemanticQuery(
    [
      {
        id: "1",
        agentId: agentId("a"),
        scope: {},
        category: "lesson",
        content: "unrelated kubernetes helm chart",
        createdAt: 0,
        lastAccessedAt: 0,
      },
    ],
    "typescript async await tutorial",
    { minSimilarity: 0.9 },
  );
  assert.equal(ranked.length, 0);
});
