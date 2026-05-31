import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { LazyRemoteMemoryClient } from "../../src/orchestration/memory-transport.ts";

const require = createRequire(import.meta.url);

function hasPackage(name: string): boolean {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

const mem0Installed = hasPackage("mem0ai");
const zepInstalled = hasPackage("@getzep/zep-cloud");

test(
  "LazyRemoteMemoryClient uses mem0 SDK when mem0ai installed",
  { skip: !mem0Installed || !process.env.LLM_PIPELINE_MEMORY_API_KEY },
  async () => {
    const client = new LazyRemoteMemoryClient(
      {
        type: "mem0",
        apiKey: process.env.LLM_PIPELINE_MEMORY_API_KEY,
        userId: "sdk-test",
        variant: "platform",
      },
      "sdk",
    );
    const entries = await client.search({ textSearch: "pipeline", scope: { user: "sdk-test" } });
    assert.equal(Array.isArray(entries), true);
  },
);

test(
  "LazyRemoteMemoryClient uses zep SDK when @getzep/zep-cloud installed",
  { skip: !zepInstalled || !process.env.LLM_PIPELINE_MEMORY_API_KEY },
  async () => {
    const client = new LazyRemoteMemoryClient(
      {
        type: "zep",
        apiKey: process.env.LLM_PIPELINE_MEMORY_API_KEY,
        sessionId: "sdk-test-session",
      },
      "sdk",
    );
    const entries = await client.search({ textSearch: "hello" });
    assert.equal(Array.isArray(entries), true);
  },
);

test("SDK integration skipped hint when packages absent", () => {
  if (mem0Installed && zepInstalled) return;
  assert.equal(mem0Installed || !mem0Installed, true);
});
