import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResponseCache } from "../src/routing/cache.ts";
import { ResponseCacheL2Store } from "../src/routing/cache-l2.ts";
import type { TextResponse } from "../src/providers/types.ts";

function textResp(content: string): TextResponse {
  return { kind: "text", model: "m", content, code: "", explanation: "" };
}

test("ResponseCache L2: evicted entry reloads from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "cache-l2-"));
  try {
    const l2Path = join(dir, "l2.json");
    const l2 = new ResponseCacheL2Store(l2Path, 32);
    const cache = new ResponseCache(2, 30, l2);

    cache.put("k1", textResp("one"));
    cache.put("k2", textResp("two"));
    cache.put("k3", textResp("three"));

    assert.equal(l2.get("k1")?.response.content, "one");

    const cache2 = new ResponseCache(2, 30, new ResponseCacheL2Store(l2Path, 32), { warmL2: false });
    cache2.put("ka", textResp("a"));
    cache2.put("kb", textResp("b"));
    assert.equal(cache2.get("k1")?.content, "one");
    assert.equal(cache2.getStats().l2Hits, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
