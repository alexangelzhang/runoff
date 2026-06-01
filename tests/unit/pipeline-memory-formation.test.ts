import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig } from "../../src/core/config.ts";
import type { PipelineTrace } from "../../src/observability/trace.ts";
import { InMemoryAgentMemory } from "../../src/orchestration/memory.ts";
import { applyMemoryForgetPass } from "../../src/memory/memory-forget-pass.ts";
import { resetPipelineMemoryFormationQueue } from "../../src/memory/pipeline-memory-formation-queue.ts";
import {
  PipelineHooks,
  resetSharedMemory,
  flushPipelineMemoryFormationQueue,
  getPipelineSharedMemory,
} from "../../src/pipeline/pipeline-hooks.ts";
import { CostTracker } from "../../src/routing/pricing.ts";
import { queryEntityVerdicts } from "../../src/orchestration/trace-entities.ts";
import { agentId } from "../../src/orchestration/multi-agent-types.ts";

test("applyMemoryForgetPass removes low-relevance entries", () => {
  const mem = new InMemoryAgentMemory();
  const scope = { project: "p" };
  mem.store({
    agentId: agentId("test"),
    scope,
    category: "pattern",
    content: "stale",
    relevance: 0.01,
  });
  mem.store({
    agentId: agentId("test"),
    scope,
    category: "pattern",
    content: "fresh",
    relevance: 0.9,
  });

  const { forgotten } = applyMemoryForgetPass(mem, { scope, forgetBelowRelevance: 0.05 });
  assert.equal(forgotten, 1);
  assert.equal(mem.retrieve({ scope, textSearch: "fresh" }).length, 1);
  assert.equal(mem.retrieve({ scope, textSearch: "stale" }).length, 0);
});

test("formation queue writes entity relations after flush", async () => {
  const home = mkdtempSync(join(tmpdir(), "formation-q-"));
  const prev = process.env.RUNOFF_HOME;
  process.env.RUNOFF_HOME = home;
  resetSharedMemory();

  const config: PipelineConfig = {
    providers: { mock: { type: "mock" } },
    pipeline: { draft: ["mock"] },
    orchestration: { memoryFormationAsync: true, memoryHotPathForget: false },
  };

  const trace: PipelineTrace = {
    id: "trace-q",
    prompt: "fix auth",
    promptLength: 8,
    mode: "pipeline",
    steps: [{ name: "draft", provider: "mock", durationMs: 1, round: 1, filesModified: ["src/q.ts"] }],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1,
    hasVerifyResults: false,
    timestamp: new Date().toISOString(),
    lifecycle: "final",
  };

  try {
    const hooks = new PipelineHooks(config, "trace-q", "sess-q");
    await hooks.onPipelineEnd({ trace, costTracker: new CostTracker(), config });
    await flushPipelineMemoryFormationQueue();

    const edges = queryEntityVerdicts(getPipelineSharedMemory(), {
      provider: "mock",
      file: "src/q.ts",
      scope: { project: "default" },
    });
    assert.ok(edges.length >= 1);
  } finally {
    if (prev === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = prev;
    rmSync(home, { recursive: true, force: true });
    resetSharedMemory();
    resetPipelineMemoryFormationQueue();
  }
});

test("memoryFormationAsync false runs formation inline", async () => {
  const home = mkdtempSync(join(tmpdir(), "formation-sync-"));
  const prev = process.env.RUNOFF_HOME;
  process.env.RUNOFF_HOME = home;
  resetSharedMemory();

  const config: PipelineConfig = {
    providers: { mock: { type: "mock" } },
    pipeline: { draft: ["mock"] },
    orchestration: { memoryFormationAsync: false, memoryHotPathForget: false },
  };

  const trace: PipelineTrace = {
    id: "trace-sync",
    prompt: "fix",
    promptLength: 3,
    mode: "pipeline",
    steps: [{ name: "draft", provider: "mock", durationMs: 1, round: 1, filesModified: ["src/sync.ts"] }],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1,
    hasVerifyResults: false,
    timestamp: new Date().toISOString(),
    lifecycle: "final",
  };

  try {
    const hooks = new PipelineHooks(config, "trace-sync", "sess-sync");
    await hooks.onPipelineEnd({ trace, costTracker: new CostTracker(), config });

    const edges = queryEntityVerdicts(getPipelineSharedMemory(), {
      provider: "mock",
      file: "src/sync.ts",
      scope: { project: "default" },
    });
    assert.ok(edges.length >= 1);
  } finally {
    if (prev === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = prev;
    rmSync(home, { recursive: true, force: true });
    resetSharedMemory();
  }
});
