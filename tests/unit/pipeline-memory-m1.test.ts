import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig } from "../../src/core/config.ts";
import {
  getPipelineMemory,
  getPipelineMemorySessionKey,
  resetPipelineMemoryRegistry,
} from "../../src/memory/pipeline-memory.ts";
import { LayeredAgentMemory } from "../../src/orchestration/http-memory-client.ts";
import { defaultDreamState, loadDreamState, touchDreamState, getDreamStatePath } from "../../src/memory/dream-state.ts";
import { PatternCache } from "../../src/orchestration/pattern-cache.ts";
import { PipelineHooks, resetSharedMemory } from "../../src/pipeline/pipeline-hooks.ts";

let memDir: string;
let origHome: string | undefined;

test.beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), "pipeline-m1-"));
  origHome = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = memDir;
  resetSharedMemory();
});

test.afterEach(() => {
  if (origHome !== undefined) process.env.LLM_PIPELINE_HOME = origHome;
  else delete process.env.LLM_PIPELINE_HOME;
  rmSync(memDir, { recursive: true, force: true });
});

const baseConfig: PipelineConfig = {
  providers: { m: { type: "mock" } },
  pipeline: { s: ["m"] },
};

test("dream-state defaults and persists", () => {
  assert.deepEqual(loadDreamState(), defaultDreamState());
  touchDreamState(new Date("2026-05-28T12:00:00.000Z"));
  assert.equal(loadDreamState().lastDreamAt, "2026-05-28T12:00:00.000Z");
  const raw = JSON.parse(readFileSync(getDreamStatePath(), "utf8")) as { version: number };
  assert.equal(raw.version, 1);
});

test("zep session keys differ per pipeline sessionId", () => {
  const config: PipelineConfig = {
    ...baseConfig,
    orchestration: {
      mode: "dag",
      memoryBackend: { type: "zep", apiKey: "z-key" },
    },
  };
  assert.notEqual(
    getPipelineMemorySessionKey(config, "sess-a"),
    getPipelineMemorySessionKey(config, "sess-b"),
  );
  const memA = getPipelineMemory(config, "sess-a");
  const memB = getPipelineMemory(config, "sess-b");
  assert.equal(memA instanceof LayeredAgentMemory, true);
  assert.equal(memB instanceof LayeredAgentMemory, true);
  assert.notEqual(memA, memB);
});

test("hybrid pattern retrieve falls back on timeout", async () => {
  const config: PipelineConfig = {
    ...baseConfig,
    orchestration: {
      mode: "dag",
      memoryBackend: { type: "http", baseUrl: "http://127.0.0.1:19998" },
    },
  };
  const mem = getPipelineMemory(config, "s1");
  const cache = new PatternCache(mem, { project: "default" });
  const ctx = await cache.buildAssociativeContextAsync("optimize database queries", 3, {
    hybridRetrieve: true,
    timeoutMs: 50,
  });
  assert.equal(typeof ctx, "string");
});

test("PipelineHooks onPipelineStart is async and returns pattern context", async () => {
  const config = makeHooksConfig();
  const hooks = new PipelineHooks(config, "trace-m1", "session-m1");
  const result = await hooks.onPipelineStart({
    prompt: "fix auth module",
    config,
    traceId: "trace-m1",
    sessionId: "session-m1",
  });
  assert.equal(typeof result.patternContext, "string");
});

test("memoryHybridRetrieve defaults off on layered backend", async () => {
  const config: PipelineConfig = {
    providers: { p: { type: "mock" } },
    pipeline: { draft: ["p"] },
    orchestration: {
      mode: "dag",
      memoryBackend: { type: "http", baseUrl: "http://127.0.0.1:19997" },
    },
  };
  let mergedCalls = 0;
  const orig = LayeredAgentMemory.prototype.retrieveMerged;
  LayeredAgentMemory.prototype.retrieveMerged = async function () {
    mergedCalls++;
    return [];
  };
  try {
    const hooks = new PipelineHooks(config, "trace-g5", "session-g5");
    await hooks.onPipelineStart({
      prompt: "unique default-off hybrid probe xyzzy",
      config,
      traceId: "trace-g5",
      sessionId: "session-g5",
    });
    assert.equal(mergedCalls, 0);
  } finally {
    LayeredAgentMemory.prototype.retrieveMerged = orig;
  }
});

test("memoryHybridRetrieve true invokes retrieveMerged through PipelineHooks", async () => {
  const config: PipelineConfig = {
    providers: { p: { type: "mock" } },
    pipeline: { draft: ["p"] },
    orchestration: {
      mode: "dag",
      memoryBackend: { type: "http", baseUrl: "http://127.0.0.1:19996" },
      memoryHybridRetrieve: true,
      memoryHybridRetrieveTimeoutMs: 100,
    },
  };
  let mergedCalls = 0;
  const orig = LayeredAgentMemory.prototype.retrieveMerged;
  LayeredAgentMemory.prototype.retrieveMerged = async function () {
    mergedCalls++;
    return [];
  };
  try {
    const hooks = new PipelineHooks(config, "trace-hybrid", "session-hybrid");
    await hooks.onPipelineStart({
      prompt: "unique hybrid-on probe xyzzy plugh",
      config,
      traceId: "trace-hybrid",
      sessionId: "session-hybrid",
    });
    assert.ok(mergedCalls >= 1);
  } finally {
    LayeredAgentMemory.prototype.retrieveMerged = orig;
  }
});

function makeHooksConfig(): PipelineConfig {
  return {
    providers: { p: { type: "mock" } },
    pipeline: { draft: ["p"] },
  };
}
