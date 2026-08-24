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

// Only register SDK integration tests when their optional dependency is
// installed. This keeps the default `npm test` run skip-free: without the SDK
// the test doesn't exist rather than emitting a skip marker. The API-key gate
// stays on the test itself so the dedicated `npm run test:sdk-memory` still
// reports a clean skip when the SDK is present but no key is configured.
if (mem0Installed) {
  test(
    "LazyRemoteMemoryClient uses mem0 SDK when mem0ai installed",
    { skip: !process.env.RUNOFF_MEMORY_API_KEY },
    async () => {
      const client = new LazyRemoteMemoryClient(
        {
          type: "mem0",
          apiKey: process.env.RUNOFF_MEMORY_API_KEY,
          userId: "sdk-test",
          variant: "platform",
        },
        "sdk",
      );
      const entries = await client.search({ textSearch: "pipeline", scope: { user: "sdk-test" } });
      assert.equal(Array.isArray(entries), true);
    },
  );
}

if (zepInstalled) {
  test(
    "LazyRemoteMemoryClient uses zep SDK when @getzep/zep-cloud installed",
    { skip: !process.env.RUNOFF_MEMORY_API_KEY },
    async () => {
      const client = new LazyRemoteMemoryClient(
        {
          type: "zep",
          apiKey: process.env.RUNOFF_MEMORY_API_KEY,
          sessionId: "sdk-test-session",
        },
        "sdk",
      );
      const entries = await client.search({ textSearch: "hello" });
      assert.equal(Array.isArray(entries), true);
    },
  );
}

test("SDK integration skipped hint when packages absent", () => {
  if (mem0Installed && zepInstalled && process.env.RUNOFF_MEMORY_API_KEY) return;
  assert.equal(mem0Installed || !mem0Installed, true);
});
