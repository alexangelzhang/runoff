import assert from "node:assert/strict";
import test from "node:test";
import {
  createRemoteMemoryClient,
  LazyRemoteMemoryClient,
} from "../../src/orchestration/memory-transport.ts";

test("createRemoteMemoryClient rest returns Mem0 REST adapter", () => {
  const client = createRemoteMemoryClient(
    {
      type: "mem0",
      baseUrl: "https://api.mem0.ai",
      apiKey: "k",
      variant: "platform",
    },
    "rest",
  );
  assert.ok(client);
  assert.equal(client instanceof LazyRemoteMemoryClient, false);
});

test("createRemoteMemoryClient auto uses lazy SDK wrapper", () => {
  const client = createRemoteMemoryClient(
    {
      type: "zep",
      baseUrl: "https://api.getzep.com/api/v2",
      apiKey: "z",
    },
    "auto",
  );
  assert.equal(client instanceof LazyRemoteMemoryClient, true);
});

test("LazyRemoteMemoryClient falls back to REST search without SDK", async () => {
  const client = new LazyRemoteMemoryClient(
    {
      type: "http",
      baseUrl: "http://127.0.0.1:1",
    },
    "auto",
  );
  const entries = await client.search({ textSearch: "hello" });
  assert.equal(Array.isArray(entries), true);
});
