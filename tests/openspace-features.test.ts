/**
 * Tests for OpenSpace-inspired features:
 * - Feature 4: Token economics reporting
 * - Feature 1: Pattern-based skill cache
 * - Feature 3: Persistent cross-run knowledge sharing
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  computeTokenEconomics,
  compareTraceEconomics,
  type PipelineTrace,
  type TokenEconomics,
} from "../src/observability/trace.js";
import { InMemoryAgentMemory } from "../src/orchestration/memory.js";
import { PatternCache, extractPattern } from "../src/orchestration/pattern-cache.js";
import { PersistentAgentMemory } from "../src/orchestration/persistent-memory.js";
import { agentId } from "../src/orchestration/multi-agent-types.js";

// --- Helpers ---

function makeTrace(overrides: Partial<PipelineTrace> = {}): PipelineTrace {
  return {
    id: "t1",
    prompt: "fix the login bug in auth module",
    promptLength: 40,
    mode: "pipeline",
    steps: [
      {
        name: "draft",
        provider: "claude",
        durationMs: 1000,
        round: 1,
        usage: { promptTokens: 500, completionTokens: 200 },
      },
      {
        name: "review",
        provider: "gpt4",
        durationMs: 800,
        round: 1,
        usage: { promptTokens: 300, completionTokens: 100 },
        cached: true,
      },
    ],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1800,
    hasVerifyResults: false,
    timestamp: "2026-03-30T10:00:00Z",
    totalUsage: { promptTokens: 800, completionTokens: 300 },
    ...overrides,
  };
}

// ============================================================
// Feature 4: Token Economics
// ============================================================

describe("Token Economics", () => {
  it("computes totals from traces", () => {
    const traces = [makeTrace()];
    const econ = computeTokenEconomics(traces);

    assert.equal(econ.totalPromptTokens, 800);
    assert.equal(econ.totalCompletionTokens, 300);
    assert.equal(econ.totalTokens, 1100);
    assert.equal(econ.avgTokensPerTrace, 1100);
    assert.equal(econ.cachedStepCount, 1);
  });

  it("aggregates per-provider tokens", () => {
    const econ = computeTokenEconomics([makeTrace()]);

    assert.equal(econ.providerTokens["claude"].total, 700);
    assert.equal(econ.providerTokens["gpt4"].total, 400);
    assert.equal(econ.providerTokens["claude"].promptTokens, 500);
    assert.equal(econ.providerTokens["gpt4"].completionTokens, 100);
  });

  it("handles empty traces", () => {
    const econ = computeTokenEconomics([]);
    assert.equal(econ.totalTokens, 0);
    assert.equal(econ.avgTokensPerTrace, 0);
    assert.equal(econ.cachedStepCount, 0);
  });

  it("handles traces without usage data", () => {
    const trace = makeTrace({
      totalUsage: undefined,
      steps: [{ name: "draft", provider: "claude", durationMs: 500, round: 1 }],
    });
    const econ = computeTokenEconomics([trace]);
    assert.equal(econ.totalTokens, 0);
  });

  it("compares cold vs warm runs", () => {
    const cold = [makeTrace({ totalUsage: { promptTokens: 1000, completionTokens: 500 } })];
    const warm = [makeTrace({ totalUsage: { promptTokens: 400, completionTokens: 200 } })];

    const cmp = compareTraceEconomics(cold, warm);
    assert.equal(cmp.baselineTokens, 1500);
    assert.equal(cmp.comparisonTokens, 600);
    assert.equal(cmp.savedTokens, 900);
    assert.equal(cmp.ratio, 0.4);
    assert.equal(cmp.savedPercent, 60);
  });

  it("handles zero baseline in comparison", () => {
    const cmp = compareTraceEconomics([], [makeTrace()]);
    assert.equal(cmp.ratio, 1);
    assert.equal(cmp.savedPercent, 0);
  });

  it("averages across multiple traces", () => {
    const t1 = makeTrace({ totalUsage: { promptTokens: 600, completionTokens: 400 } });
    const t2 = makeTrace({ id: "t2", totalUsage: { promptTokens: 200, completionTokens: 100 } });
    const econ = computeTokenEconomics([t1, t2]);
    assert.equal(econ.totalTokens, 1300);
    assert.equal(econ.avgTokensPerTrace, 650);
  });
});

// ============================================================
// Feature 1: Pattern Cache
// ============================================================

describe("Pattern Cache", () => {
  let memory: InMemoryAgentMemory;
  let cache: PatternCache;

  beforeEach(() => {
    memory = new InMemoryAgentMemory();
    cache = new PatternCache(memory);
  });

  describe("extractPattern", () => {
    it("extracts pattern from approved trace", () => {
      const pattern = extractPattern(makeTrace());
      assert.ok(pattern);
      assert.deepEqual(pattern.providerChain, ["claude", "gpt4"]);
      assert.equal(pattern.rounds, 1);
      assert.equal(pattern.totalTokens, 1100);
      assert.equal(pattern.stepHints.length, 2);
    });

    it("returns null for failed traces", () => {
      assert.equal(extractPattern(makeTrace({ finalStatus: "failed" })), null);
    });

    it("returns null for empty steps", () => {
      assert.equal(extractPattern(makeTrace({ steps: [] })), null);
    });

    it("skips errored steps in hints", () => {
      const trace = makeTrace({
        steps: [
          { name: "draft", provider: "claude", durationMs: 500, round: 1, error: "timeout" },
          { name: "review", provider: "gpt4", durationMs: 300, round: 1 },
        ],
      });
      const pattern = extractPattern(trace);
      assert.ok(pattern);
      assert.equal(pattern.stepHints.length, 1);
      assert.equal(pattern.stepHints[0].provider, "gpt4");
    });

    it("truncates long prompts", () => {
      const longPrompt = "a".repeat(500);
      const pattern = extractPattern(makeTrace({ prompt: longPrompt }));
      assert.ok(pattern);
      assert.equal(pattern.promptSummary.length, 200);
    });
  });

  describe("store and match", () => {
    it("stores and retrieves by exact prompt", () => {
      cache.storeFromTrace(makeTrace());
      const matches = cache.matchPatterns("fix the login bug in auth module");
      assert.equal(matches.length, 1);
      assert.deepEqual(matches[0].providerChain, ["claude", "gpt4"]);
    });

    it("deduplicates same prompt", () => {
      cache.storeFromTrace(makeTrace());
      cache.storeFromTrace(makeTrace({ totalDurationMs: 999 }));
      assert.equal(cache.size, 1);
      const matches = cache.matchPatterns("fix the login bug in auth module");
      assert.equal(matches[0].totalDurationMs, 999);
    });

    it("returns empty for no match", () => {
      cache.storeFromTrace(makeTrace());
      const matches = cache.matchPatterns("completely unrelated query about databases");
      assert.equal(matches.length, 0);
    });

    it("does not store failed traces", () => {
      cache.storeFromTrace(makeTrace({ finalStatus: "failed" }));
      assert.equal(cache.size, 0);
    });
  });

  describe("formatAsContext", () => {
    it("formats patterns as injectable context", () => {
      const pattern = extractPattern(makeTrace())!;
      const ctx = cache.formatAsContext([pattern]);
      assert.ok(ctx.includes("Prior successful patterns"));
      assert.ok(ctx.includes("claude → gpt4"));
      assert.ok(ctx.includes("Rounds: 1"));
    });

    it("returns empty string for no patterns", () => {
      assert.equal(cache.formatAsContext([]), "");
    });
  });
});

// ============================================================
// Feature 3: Persistent Memory
// ============================================================

describe("Persistent Memory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "llm-mem-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores and retrieves entries", () => {
    const mem = new PersistentAgentMemory(tmpDir);
    mem.store({
      agentId: agentId("test"),
      scope: { project: "p1" },
      category: "pattern",
      content: "test pattern",
      relevance: 0.8,
    });

    const results = mem.retrieve({ category: "pattern" });
    assert.equal(results.length, 1);
    assert.equal(results[0].content, "test pattern");
  });

  it("persists across instances", () => {
    const mem1 = new PersistentAgentMemory(tmpDir);
    mem1.store({
      agentId: agentId("test"),
      scope: { project: "p1" },
      category: "lesson",
      content: "always validate input",
      relevance: 0.9,
    });

    // New instance loads from disk
    const mem2 = new PersistentAgentMemory(tmpDir);
    const results = mem2.retrieve({ category: "lesson" });
    assert.equal(results.length, 1);
    assert.equal(results[0].content, "always validate input");
  });

  it("forget removes from disk", () => {
    const mem = new PersistentAgentMemory(tmpDir);
    const entry = mem.store({
      agentId: agentId("test"),
      scope: {},
      category: "context",
      content: "temp",
    });
    assert.equal(mem.size, 1);
    mem.forget(entry.id);
    assert.equal(mem.size, 0);

    // Verify gone from disk
    const mem2 = new PersistentAgentMemory(tmpDir);
    assert.equal(mem2.size, 0);
  });

  it("forgetByScope removes matching entries", () => {
    const mem = new PersistentAgentMemory(tmpDir);
    mem.store({ agentId: agentId("a"), scope: { project: "p1" }, category: "pattern", content: "x" });
    mem.store({ agentId: agentId("a"), scope: { project: "p2" }, category: "pattern", content: "y" });
    const removed = mem.forgetByScope({ project: "p1" });
    assert.equal(removed, 1);
    assert.equal(mem.size, 1);
  });

  it("respects TTL on retrieve", async () => {
    const mem = new PersistentAgentMemory(tmpDir);
    mem.store({
      agentId: agentId("test"),
      scope: {},
      category: "context",
      content: "expired",
      ttlMs: 1, // 1ms TTL
    });
    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 5));
    const results = mem.retrieve({ category: "context" });
    assert.equal(results.length, 0);

    // But includeExpired returns it
    const all = mem.retrieve({ category: "context", includeExpired: true });
    assert.equal(all.length, 1);
  });

  it("updateRelevance persists to disk", () => {
    const mem1 = new PersistentAgentMemory(tmpDir);
    const entry = mem1.store({
      agentId: agentId("test"),
      scope: {},
      category: "pattern",
      content: "test",
      relevance: 0.5,
    });
    mem1.updateRelevance(entry.id, 0.95);

    const mem2 = new PersistentAgentMemory(tmpDir);
    const results = mem2.retrieve({ minRelevance: 0.9 });
    assert.equal(results.length, 1);
    assert.equal(results[0].relevance, 0.95);
  });

  it("clear removes all files", () => {
    const mem = new PersistentAgentMemory(tmpDir);
    mem.store({ agentId: agentId("a"), scope: {}, category: "pattern", content: "1" });
    mem.store({ agentId: agentId("a"), scope: {}, category: "pattern", content: "2" });
    mem.clear();
    assert.equal(mem.size, 0);

    const mem2 = new PersistentAgentMemory(tmpDir);
    assert.equal(mem2.size, 0);
  });

  it("text search works across persisted entries", () => {
    const mem = new PersistentAgentMemory(tmpDir);
    mem.store({ agentId: agentId("a"), scope: {}, category: "pattern", content: "login auth fix" });
    mem.store({ agentId: agentId("a"), scope: {}, category: "pattern", content: "database migration" });

    const results = mem.retrieve({ textSearch: "auth" });
    assert.equal(results.length, 1);
    assert.ok(results[0].content.includes("auth"));
  });
});
