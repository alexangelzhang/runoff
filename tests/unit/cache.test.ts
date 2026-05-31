import assert from "node:assert/strict";
import test from "node:test";
import { ResponseCache } from "../../src/routing/cache.ts";
import type { LLMResponse } from "../../src/providers/types.ts";

function makeResponse(code: string): LLMResponse {
  return {
    kind: "text",
    content: code,
    code,
    explanation: "",
    model: "test",
  };
}

test("cache: put and get returns cached response", () => {
  const cache = new ResponseCache(10, 30);
  const resp = makeResponse("const x = 1;");
  cache.put("key1", resp);
  const got = cache.get("key1");
  assert.deepEqual(got, resp);
});

test("cache: miss returns null and increments miss count", () => {
  const cache = new ResponseCache(10, 30);
  const got = cache.get("nonexistent");
  assert.equal(got, null);
  assert.equal(cache.getStats().misses, 1);
});

test("cache: hit increments hit count", () => {
  const cache = new ResponseCache(10, 30);
  cache.put("key1", makeResponse("x"));
  cache.get("key1");
  cache.get("key1");
  const stats = cache.getStats();
  assert.equal(stats.hits, 2);
});

test("cache: LRU eviction when at capacity", async () => {
  const cache = new ResponseCache(2, 30);
  cache.put("a", makeResponse("a"));

  // Wait 1ms so "b" has a later lastAccess than "a"
  await new Promise((r) => setTimeout(r, 5));
  cache.put("b", makeResponse("b"));

  // Access "a" to make it most-recently-used, "b" becomes LRU
  await new Promise((r) => setTimeout(r, 5));
  cache.get("a");

  // Adding "c" should evict "b" (least recently used)
  cache.put("c", makeResponse("c"));

  assert.notEqual(cache.get("a"), null);  // still there
  assert.equal(cache.get("b"), null);     // evicted
  assert.notEqual(cache.get("c"), null);  // still there
  assert.equal(cache.getStats().evictions, 1);
});

test("cache: TTL expiration", async () => {
  // Create cache with 0-minute TTL (ttlMs = 0, expires when Date.now() > createdAt)
  const cache = new ResponseCache(10, 0);
  cache.put("key1", makeResponse("x"));

  // Wait 1ms so Date.now() - createdAt > 0
  await new Promise((r) => setTimeout(r, 5));

  const got = cache.get("key1");
  assert.equal(got, null);
  assert.equal(cache.getStats().misses, 1);
});

test("cache: static key is deterministic", () => {
  const k1 = ResponseCache.key("provider", "prompt", "ts", "ctx");
  const k2 = ResponseCache.key("provider", "prompt", "ts", "ctx");
  assert.equal(k1, k2);
});

test("cache: static key differs for different inputs", () => {
  const k1 = ResponseCache.key("provider", "prompt1");
  const k2 = ResponseCache.key("provider", "prompt2");
  assert.notEqual(k1, k2);
});

test("cache: overwriting existing key does not trigger eviction", () => {
  const cache = new ResponseCache(2, 30);
  cache.put("a", makeResponse("v1"));
  cache.put("b", makeResponse("v2"));
  cache.put("a", makeResponse("v3")); // overwrite, should NOT evict

  assert.equal(cache.getStats().evictions, 0);
  assert.equal(cache.getStats().size, 2);
});
